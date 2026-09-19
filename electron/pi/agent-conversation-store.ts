import path from 'node:path'

import {
  BACKGROUND_CONTEXT,
  JsonlSessionRepo,
  type Entry,
  type JsonlSessionMetadata,
  type Session,
} from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/harness/env/nodejs'
import { laneConfig } from '@earendil-works/pi-agent-core/harness/session'

import { DIR_VELA_INTERNAL } from '../../src/shared/project-paths'
import { logFailure, logInfo } from '../../src/shared/fail-log'
import { MODELS_CONFIG_PATH, readJsonFile, VELA_HOME } from '../utils/config-utils'
import { AGENT_LANE_NAME, VELA_SESSION_CONFIG } from './agent-session'
import { isAssistantThinkingLevel, type AssistantThinkingLevel } from '../../src/shared/agent-runtime'
import type { ModelProfile } from '../../src/shared/ipc-channels'
import type {
  PersistedAgentConversation,
  PersistedAgentMessage,
} from '../../src/shared/agent-conversation-archive'

/** 会话文件所在的一级目录名（项目内与 `~/.vela` 下同名）。 */
export const SESSIONS_DIR = 'agent-sessions'

export interface AgentConversationStoreRoot {
  /** 会话文件根目录。 */
  sessionsRoot: string
  /** 这个 store 服务的项目根；决定 Pi 会话元数据里的 cwd。 */
  cwd: string
}

/**
 * 将底层原始 Entry 事件列表折叠转换为符合前端展示的气泡消息结构。
 * 严格保持时间升序（最早消息在前，最新消息在后）。
 */
export function foldEntriesToMessages(entries: readonly Entry[]): PersistedAgentMessage[] {
  // 必须严格按序列号/时间戳升序排序，杜绝底层倒序扫描带来的错位
  const sortedEntries = [...entries].sort((a, b) => {
    if (typeof a.seq === 'number' && typeof b.seq === 'number' && a.seq !== b.seq) {
      return a.seq - b.seq
    }
    return (a.timestamp || 0) - (b.timestamp || 0)
  })

  const foldedMessages: PersistedAgentMessage[] = []
  let currentAssistant: PersistedAgentMessage | null = null
  const toolResultsById = new Map<string, { text: string; isError?: boolean; details?: unknown }>()

  // 1. 收集所有 toolResult / tool 回执
  for (const it of sortedEntries) {
    if (it.type !== 'message') continue
    const m = it.message as unknown as Record<string, unknown>
    if (m.role === 'toolResult' || m.role === 'tool') {
      const toolCallId = String(m.toolCallId ?? '')
      let resultText = ''
      const content = m.content
      if (Array.isArray(content)) {
        for (const p of content) {
          if (p && typeof p === 'object' && 'text' in p && typeof p.text === 'string') {
            resultText += p.text
          }
        }
      } else if (typeof content === 'string') {
        resultText = content
      }
      toolResultsById.set(toolCallId, {
        text: resultText,
        isError: Boolean(m.isError),
        details: m.details,
      })
    }
  }

  // 2. 遍历消息条目还原 user 与 assistant
  for (const it of sortedEntries) {
    if (it.type !== 'message') continue
    const m = it.message as unknown as Record<string, unknown>
    const role = m.role
    const ts = it.timestamp || (typeof m.timestamp === 'number' ? m.timestamp : Date.now())
    const eid = it.id

    if (role === 'user') {
      currentAssistant = null
      let userText = ''
      const content = m.content
      if (Array.isArray(content)) {
        for (const p of content) {
          if (p && typeof p === 'object' && 'text' in p && typeof p.text === 'string') {
            userText += p.text
          }
        }
      } else if (typeof content === 'string') {
        userText = content
      }
      foldedMessages.push({
        id: eid,
        role: 'user',
        content: userText,
        createdAt: ts,
      })
    } else if (role === 'assistant') {
      let assistantText = ''
      const toolCalls: Record<string, unknown>[] = []
      const content = m.content
      if (Array.isArray(content)) {
        for (const p of content) {
          if (!p || typeof p !== 'object') continue
          const part = p as Record<string, unknown>
          if (part.type === 'text' && typeof part.text === 'string') {
            assistantText += part.text
          } else if (part.type === 'toolCall') {
            const tcid = String(part.id ?? '')
            const tname = String(part.name ?? '')
            const targs = part.arguments as Record<string, unknown>
            const res = toolResultsById.get(tcid)
            toolCalls.push({
              id: tcid,
              toolName: tname,
              arguments: targs ?? {},
              status: res?.isError ? 'failed' : 'completed',
              result: res?.text,
              details: res?.details,
              error: res?.isError ? res.text : undefined,
              source: tname.startsWith('mcp__') ? 'mcp' : 'builtin',
            })
          }
        }
      } else if (typeof content === 'string') {
        assistantText = content
      }

      // 如果上一条也是同一个回合的 assistant 消息，合并文本与工具调用
      if (currentAssistant && foldedMessages.length > 0 && foldedMessages[foldedMessages.length - 1] === currentAssistant) {
        if (assistantText) {
          currentAssistant.content = currentAssistant.content
            ? `${currentAssistant.content}\n\n${assistantText}`
            : assistantText
        }
        if (toolCalls.length > 0) {
          const prevCalls = (currentAssistant.toolCalls as Record<string, unknown>[]) || []
          currentAssistant.toolCalls = [...prevCalls, ...toolCalls]
        }
      } else {
        currentAssistant = {
          id: eid,
          role: 'assistant',
          content: assistantText,
          createdAt: ts,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        }
        foldedMessages.push(currentAssistant)
      }
    }
  }

  // 严格按时间升序返回（最早在 index 0，最新在最末尾）
  foldedMessages.sort((a, b) => a.createdAt - b.createdAt)
  return foldedMessages
}

/**
 * 一个作用域的 Pi 会话仓储服务（单一真实数据源）。
 *
 * 负责会话的创建、打开、扫描还原、重命名与删除。
 */
export class AgentConversationStore {
  private readonly fileSystem: NodeExecutionEnv
  private readonly repo: JsonlSessionRepo
  private readonly opened = new Map<string, Session<JsonlSessionMetadata>>()
  private readonly known = new Map<string, JsonlSessionMetadata>()
  private scanned = false
  private closed = false

  /** 项目助手：会话存档落在项目内，跟随书一起备份/删除。 */
  static forProject(projectPath: string): AgentConversationStore {
    return new AgentConversationStore({
      sessionsRoot: path.join(projectPath, DIR_VELA_INTERNAL, SESSIONS_DIR),
      cwd: projectPath,
    })
  }

  /** 界面助手：会话存档落在应用数据目录，与项目无关。 */
  static forGlobal(appDataRoot: string = VELA_HOME): AgentConversationStore {
    return new AgentConversationStore({
      sessionsRoot: path.join(appDataRoot, SESSIONS_DIR),
      cwd: appDataRoot,
    })
  }

  private readonly cwd: string

  constructor(root: AgentConversationStoreRoot) {
    this.cwd = root.cwd
    this.fileSystem = new NodeExecutionEnv({ cwd: root.cwd })
    this.repo = new JsonlSessionRepo({
      fileSystem: this.fileSystem,
      sessionsRoot: root.sessionsRoot,
    })
  }

  /**
   * 取这个对话的 Pi 会话；`create` 为真时没有就建一个。
   */
  async open(
    conversationId: string,
    options: { create?: boolean } = {},
  ): Promise<Session<JsonlSessionMetadata> | null> {
    return this.sessionFor(conversationId, options.create ?? false)
  }

  /**
   * 忘掉一个已关闭的会话。
   */
  forget(conversationId: string): void {
    this.opened.delete(conversationId)
  }

  async delete(conversationId: string): Promise<void> {
    const metadata = await this.metadataFor(conversationId)
    if (!metadata) return
    const open = this.opened.get(conversationId)
    if (open) {
      this.opened.delete(conversationId)
      await open.close(BACKGROUND_CONTEXT)
    }
    await this.repo.delete(metadata, BACKGROUND_CONTEXT)
    this.known.delete(conversationId)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const session of this.opened.values()) {
      try {
        await session.close(BACKGROUND_CONTEXT)
      } catch (error) {
        logFailure('Agent', 'failed to close conversation session', error)
      }
    }
    this.opened.clear()
    try {
      await this.repo.close(BACKGROUND_CONTEXT)
    } catch (error) {
      logFailure('Agent', 'failed to close conversation session repo', error)
    }
  }

  /**
   * 扫描并还原底层所有会话，按最新修改时间倒序排列。
   */
  async listConversations(): Promise<PersistedAgentConversation[]> {
    if (this.closed) return []

    const metadataList = await this.repo.list({ cwd: this.cwd }, BACKGROUND_CONTEXT)
    this.known.clear()
    for (const meta of metadataList) this.known.set(meta.id, meta)
    this.scanned = true

    const conversations: PersistedAgentConversation[] = []
    for (const meta of metadataList) {
      try {
        const conv = await this.hydrateSession(meta)
        if (conv) conversations.push(conv)
      } catch (err) {
        logFailure('Agent', 'failed to hydrate session', err, { conversationId: meta.id })
      }
    }

    // 按最后修改/发言时间降序排列
    conversations.sort((a, b) => b.updatedAt - a.updatedAt)
    return conversations
  }

  /**
   * 获取单个会话的完整消息树。
   */
  async getConversation(conversationId: string): Promise<PersistedAgentConversation | null> {
    if (this.closed) return null
    const meta = await this.metadataFor(conversationId)
    if (!meta) return null
    return this.hydrateSession(meta)
  }

  /**
   * 重命名会话：利用原生 Session.setName 持久化固化至 .jsonl。
   */
  async renameConversation(conversationId: string, title: string): Promise<boolean> {
    if (this.closed) return false
    const session = await this.sessionFor(conversationId, false)
    if (!session) return false
    try {
      await session.setName(title, BACKGROUND_CONTEXT)
      return true
    } catch (err) {
      logFailure('Agent', 'failed to rename conversation session', err, { conversationId })
      return false
    }
  }

  private async hydrateSession(meta: JsonlSessionMetadata): Promise<PersistedAgentConversation | null> {
    const session = await this.sessionFor(meta.id, false)
    if (!session) return null

    let customName: string | undefined
    try {
      customName = await session.getName(BACKGROUND_CONTEXT)
    } catch {
      // session may not have custom name
    }

    const branch = await session.branch('main', BACKGROUND_CONTEXT)
    const entries = (await branch?.findEntries({ order: 'oldestFirst' }, BACKGROUND_CONTEXT)) ?? []
    const messages = foldEntriesToMessages(entries)

    let title = customName
    if (!title || !title.trim()) {
      const firstUserMsg = messages.find(m => m.role === 'user')
      if (firstUserMsg && firstUserMsg.content.trim()) {
        const clean = firstUserMsg.content.replace(/\s+/g, ' ').trim()
        title = clean.length > 24 ? `${clean.slice(0, 24)}…` : clean
      } else {
        title = '新对话'
      }
    }

    const lastMsgTime = messages.length > 0 ? messages[messages.length - 1].createdAt : 0
    const updatedAt = Math.max(meta.modifiedAt || 0, meta.createdAt || 0, lastMsgTime)

    let thinkingLevel: AssistantThinkingLevel | null = null
    let modelId: string | null = null
    try {
      // 1. 优先读取 Vela 原生写入的权威配置快照（包含确切的 ModelProfile.id 与 thinkingLevel）
      const velaConfig = await session.getValue(VELA_SESSION_CONFIG, BACKGROUND_CONTEXT)
      const velaVal = velaConfig?.value as {
        modelId?: string
        thinkingLevel?: string
      } | undefined

      if (typeof velaVal?.modelId === 'string' && velaVal.modelId) {
        modelId = velaVal.modelId
      }
      if (velaVal?.thinkingLevel && isAssistantThinkingLevel(velaVal.thinkingLevel)) {
        thinkingLevel = velaVal.thinkingLevel
      }

      // 2. 兼容老会话（未写入 VELA_SESSION_CONFIG 时，从 laneConfig 兼容提取）
      if (!modelId || !thinkingLevel) {
        const configEntry = await session.getValue(laneConfig(AGENT_LANE_NAME), BACKGROUND_CONTEXT)
        const val = configEntry?.value as {
          thinkingLevel?: string
          model?: { modelId?: string; provider?: string }
        } | undefined
        if (!thinkingLevel && val?.thinkingLevel && isAssistantThinkingLevel(val.thinkingLevel)) {
          thinkingLevel = val.thinkingLevel
        }
        if (!modelId && typeof val?.model?.modelId === 'string' && val.model.modelId) {
          const rawModelId = val.model.modelId
          const models = readJsonFile<ModelProfile[]>(MODELS_CONFIG_PATH, [])
          const matched = models.find(m => m.id === rawModelId)
            ?? models.find(m => m.modelName === rawModelId && (!val?.model?.provider || m.provider === val.model.provider))
            ?? models.find(m => m.modelName === rawModelId)
          modelId = matched ? matched.id : rawModelId
        }
      }
    } catch {
      // session may not have config yet
    }

    return {
      id: meta.id,
      title,
      messages,
      createdAt: meta.createdAt || Date.now(),
      updatedAt,
      mode: 'planning',
      modelId,
      thinkingLevel,
    }
  }

  private async sessionFor(
    conversationId: string,
    create: boolean,
  ): Promise<Session<JsonlSessionMetadata> | null> {
    if (this.closed) return null
    const cached = this.opened.get(conversationId)
    if (cached) return cached
    try {
      const metadata = await this.metadataFor(conversationId)
      if (metadata) {
        const session = await this.repo.open(metadata, BACKGROUND_CONTEXT)
        this.opened.set(conversationId, session)
        return session
      }
      if (!create) return null
      const session = await this.repo.create(
        { id: conversationId, cwd: this.cwd },
        BACKGROUND_CONTEXT,
      )
      this.opened.set(conversationId, session)
      this.known.set(conversationId, session.metadata)
      logInfo('Agent', 'conversation session created', {
        conversationId,
        path: session.metadata.path,
      })
      return session
    } catch (error) {
      logFailure('Agent', 'failed to open conversation session', error, { conversationId })
      return null
    }
  }

  private async metadataFor(conversationId: string): Promise<JsonlSessionMetadata | undefined> {
    if (!this.scanned) {
      const list = await this.repo.list({ cwd: this.cwd }, BACKGROUND_CONTEXT)
      for (const metadata of list) this.known.set(metadata.id, metadata)
      this.scanned = true
    }
    return this.known.get(conversationId)
  }
}
