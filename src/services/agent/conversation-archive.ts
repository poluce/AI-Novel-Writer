import type { ProjectSessionContext } from '../../shared/ipc-channels'
import {
  parseAgentConversationArchive,
  serializeAgentConversationArchive,
  type AgentConversationArchive,
  type PersistedAgentConversation,
} from '../../shared/agent-conversation-archive'
import { AGENT_CONVERSATIONS_FILE, DIR_VELA_INTERNAL } from '../../shared/project-paths'
import { sameProjectSessionContext } from '../../shared/project-session-context'
import { logFailure } from '../../shared/fail-log'
import type { AgentScope } from '../../shared/agent-scope'
import { ipc } from '../ipc-client'
import { requireIpcSuccess } from '../ipc-result'
import { useAgentStore, type AgentConversation } from '../../stores/agent-store'

const SAVE_DEBOUNCE_MS = 400

/**
 * 两个助手各存一份界面存档：
 * - 项目助手：`<项目>/.vela/agent-conversations.json`，随项目走；
 * - 界面助手：`~/.vela/agent-conversations.json`，由主进程读写（渲染层不碰 VELA_HOME）。
 */
const timers: Record<AgentScope, ReturnType<typeof setTimeout> | null> = {
  project: null,
  global: null,
}
const lastSavedJson: Record<AgentScope, string> = { project: '', global: '' }
let persistSubscribed = false

function archivePath(projectPath: string): string {
  return `${projectPath.replace(/[\\/]$/, '')}/${AGENT_CONVERSATIONS_FILE}`
}

function velaDir(projectPath: string): string {
  return `${projectPath.replace(/[\\/]$/, '')}/${DIR_VELA_INTERNAL}`
}

function toPersistedConversations(conversations: readonly AgentConversation[]): PersistedAgentConversation[] {
  return conversations.map(conversation => ({
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    mode: conversation.mode,
    modelId: conversation.modelId,
    messages: conversation.messages
      .filter(message => !(message.streaming && !message.content.trim()))
      .map(message => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
        ...(message.artifacts ? { artifacts: message.artifacts } : {}),
      })),
  }))
}

/** 只取某个助手的会话；活跃会话也按该作用域记忆。 */
export function snapshotArchiveForScope(scope: AgentScope): AgentConversationArchive {
  const state = useAgentStore.getState()
  const conversations = toPersistedConversations(
    state.conversations.filter(conversation => conversation.scope === scope),
  )
  const remembered = state.scopeActiveConversationIds[scope]
  const activeConversationId = remembered
    && conversations.some(conversation => conversation.id === remembered)
    ? remembered
    : conversations[0]?.id ?? null
  return { version: 1, activeConversationId, conversations }
}

export async function loadProjectAgentConversations(
  projectSession: ProjectSessionContext,
): Promise<AgentConversationArchive> {
  const filePath = archivePath(projectSession.projectPath)
  const exists = await ipc.invokeWithProjectSession(
    projectSession,
    'fs:check-exists',
    filePath,
    projectSession.projectPath,
  )
  if (!exists) return parseAgentConversationArchive(null)
  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'fs:read-file',
    filePath,
    projectSession.projectPath,
  )
  requireIpcSuccess(result, '读取助手会话')
  if (!result.content.trim()) return parseAgentConversationArchive(null)
  return parseAgentConversationArchive(JSON.parse(result.content) as unknown)
}

/** 界面助手没有项目会话，存档由主进程写进应用数据目录。 */
export async function loadGlobalAgentConversations(): Promise<AgentConversationArchive> {
  const result = await ipc.invoke('agent:load-global-conversations')
  if (!result.exists || !result.content.trim()) return parseAgentConversationArchive(null)
  return parseAgentConversationArchive(JSON.parse(result.content) as unknown)
}

export async function saveProjectAgentConversations(
  projectSession: ProjectSessionContext,
  archive: AgentConversationArchive,
): Promise<void> {
  const json = serializeAgentConversationArchive(archive.conversations, archive.activeConversationId)
  if (json === lastSavedJson.project) return
  const dirPath = velaDir(projectSession.projectPath)
  const dirExists = await ipc.invokeWithProjectSession(
    projectSession,
    'fs:check-exists',
    dirPath,
    projectSession.projectPath,
  )
  if (!dirExists) {
    requireIpcSuccess(
      await ipc.invokeWithProjectSession(
        projectSession,
        'fs:mkdir',
        dirPath,
        projectSession.projectPath,
      ),
      '创建项目配置目录',
    )
  }
  requireIpcSuccess(
    await ipc.invokeWithProjectSession(
      projectSession,
      'fs:write-file',
      archivePath(projectSession.projectPath),
      json,
      projectSession.projectPath,
    ),
    '保存助手会话',
  )
  lastSavedJson.project = json
}

export async function saveGlobalAgentConversations(
  archive: AgentConversationArchive,
): Promise<void> {
  const json = serializeAgentConversationArchive(archive.conversations, archive.activeConversationId)
  if (json === lastSavedJson.global) return
  const result = await ipc.invoke('agent:save-global-conversations', json)
  if (!result.success) throw new Error(result.error ?? '保存界面助手会话失败')
  lastSavedJson.global = json
}

async function flushScope(scope: AgentScope, projectSession: ProjectSessionContext | null): Promise<void> {
  if (scope === 'global') {
    await saveGlobalAgentConversations(snapshotArchiveForScope('global'))
    return
  }
  if (!projectSession) return
  const state = useAgentStore.getState()
  if (!sameProjectSessionContext(state.dataProjectSession, projectSession)) return
  await saveProjectAgentConversations(projectSession, snapshotArchiveForScope('project'))
}

/**
 * 把两个助手待写的存档都刷盘。项目助手需要项目会话（无项目时跳过），
 * 界面助手与项目无关，切书前也要落盘。
 */
export async function flushAgentConversations(
  projectSession: ProjectSessionContext | null | undefined,
): Promise<void> {
  for (const scope of ['project', 'global'] as const) {
    if (timers[scope]) {
      clearTimeout(timers[scope])
      timers[scope] = null
    }
  }
  for (const scope of ['project', 'global'] as const) {
    try {
      await flushScope(scope, projectSession ?? null)
    } catch (error) {
      logFailure('Agent', 'failed to persist conversations', error, {
        scope,
        projectPath: projectSession?.projectPath,
      })
    }
  }
}

export function rememberHydratedArchive(scope: AgentScope, archive: AgentConversationArchive): void {
  lastSavedJson[scope] = serializeAgentConversationArchive(
    archive.conversations,
    archive.activeConversationId,
  )
}

function schedulePersist(): void {
  const state = useAgentStore.getState()
  const scopes: AgentScope[] = ['global']
  if (state.dataProjectSession) scopes.push('project')
  for (const scope of scopes) {
    if (timers[scope]) clearTimeout(timers[scope])
    timers[scope] = setTimeout(() => {
      timers[scope] = null
      void flushAgentConversations(
        scope === 'project' ? useAgentStore.getState().dataProjectSession : null,
      )
    }, SAVE_DEBOUNCE_MS)
  }
}

export function subscribeAgentConversationPersistence(): void {
  if (persistSubscribed) return
  persistSubscribed = true
  useAgentStore.subscribe((state, previous) => {
    if (
      state.conversations === previous.conversations
      && state.activeConversationId === previous.activeConversationId
      && state.scopeActiveConversationIds === previous.scopeActiveConversationIds
    ) return
    schedulePersist()
  })
}
