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
import { ipc } from '../ipc-client'
import { requireIpcSuccess } from '../ipc-result'
import { useAgentStore, type AgentConversation } from '../../stores/agent-store'

const SAVE_DEBOUNCE_MS = 400

let saveTimer: ReturnType<typeof setTimeout> | null = null
let lastSavedJson = ''
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

function snapshotArchive(): AgentConversationArchive {
  const state = useAgentStore.getState()
  const conversations = toPersistedConversations(state.conversations)
  return {
    version: 1,
    activeConversationId: state.activeConversationId
      && conversations.some(conversation => conversation.id === state.activeConversationId)
      ? state.activeConversationId
      : conversations[0]?.id ?? null,
    conversations,
  }
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

export async function saveProjectAgentConversations(
  projectSession: ProjectSessionContext,
  archive: AgentConversationArchive,
): Promise<void> {
  const json = serializeAgentConversationArchive(archive.conversations, archive.activeConversationId)
  if (json === lastSavedJson) return
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
  lastSavedJson = json
}

export async function flushAgentConversations(
  projectSession: ProjectSessionContext | null | undefined,
): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (!projectSession) return
  const state = useAgentStore.getState()
  if (!sameProjectSessionContext(state.dataProjectSession, projectSession)) return
  try {
    await saveProjectAgentConversations(projectSession, snapshotArchive())
  } catch (error) {
    logFailure('Agent', 'failed to persist conversations', error, {
      projectPath: projectSession.projectPath,
    })
  }
}

export function rememberHydratedArchive(archive: AgentConversationArchive): void {
  lastSavedJson = serializeAgentConversationArchive(archive.conversations, archive.activeConversationId)
}

function schedulePersist(): void {
  const session = useAgentStore.getState().dataProjectSession
  if (!session) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void flushAgentConversations(session)
  }, SAVE_DEBOUNCE_MS)
}

export function subscribeAgentConversationPersistence(): void {
  if (persistSubscribed) return
  persistSubscribed = true
  useAgentStore.subscribe((state, previous) => {
    if (
      state.conversations === previous.conversations
      && state.activeConversationId === previous.activeConversationId
    ) return
    schedulePersist()
  })
}
