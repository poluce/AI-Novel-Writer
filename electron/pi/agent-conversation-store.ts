/**
 * 助手会话的 Pi 会话存档（主进程）。
 *
 * 模型侧的对话历史存在 Pi 自己的 JSONL 会话里：一个会话 = 一部书项目下的一个
 * 对话，落在 `<项目>/.vela/agent-sessions/`（`.vela` 不在文件树里显示）。
 * 渲染层的 `agent-conversations.json` 仍然负责界面（标题、工具卡片、产物），
 * 这里只存模型真正需要的东西：原始 `AgentMessage`（含工具调用与结果）和
 * Pi 写下的压缩条目。
 *
 * 为什么不再自己写一份：工具回合的结构只有 `AgentMessage` 保得住；以前把历史
 * 压成 user/assistant 文本再回灌，跨次打开项目就丢掉了工具上下文。
 *
 * 所有写失败都只记日志：存档是尽力而为的，不能因为它挡住对话本身。
 */

import path from 'node:path'

import {
  BACKGROUND_CONTEXT,
  JsonlSessionRepo,
  branchTip,
  createCompactionSummaryMessage,
  insertEntry,
  setValue,
  type AgentMessage,
  type CompactionEntry,
  type Entry,
  type JsonlSessionMetadata,
  type Session,
} from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/harness/env/nodejs'

import { DIR_VELA_INTERNAL } from '../../src/shared/project-paths'
import { logFailure, logInfo } from '../../src/shared/fail-log'

/** 单个分支：本期只有一条主线，多分支属多会话产品。 */
const BRANCH_NAME = 'main'
const SESSIONS_DIR = 'agent-sessions'

export interface AgentConversationSnapshot {
  /** 可直接灌回 `agent.state.messages` 的上下文（已应用压缩）。 */
  messages: AgentMessage[]
  /** 最近一次压缩条目，用于下一次压缩时的增量摘要。 */
  previousCompaction?: CompactionEntry
}

export interface AgentConversationCompaction {
  summary: string
  tokensBefore: number
  retainedTail: AgentMessage[]
}

export class AgentConversationStore {
  private readonly fileSystem: NodeExecutionEnv
  private readonly repo: JsonlSessionRepo
  private readonly opened = new Map<string, Session<JsonlSessionMetadata>>()
  private readonly known = new Map<string, JsonlSessionMetadata>()
  private scanned = false
  private closed = false

  constructor(readonly projectPath: string) {
    this.fileSystem = new NodeExecutionEnv({ cwd: projectPath })
    this.repo = new JsonlSessionRepo({
      fileSystem: this.fileSystem,
      sessionsRoot: path.join(projectPath, DIR_VELA_INTERNAL, SESSIONS_DIR),
    })
  }

  async load(conversationId: string): Promise<AgentConversationSnapshot | null> {
    const session = await this.sessionFor(conversationId, false)
    if (!session) return null
    const entries = await this.entriesOf(session)
    return projectContext(entries)
  }

  async appendMessages(conversationId: string, messages: readonly AgentMessage[]): Promise<void> {
    if (messages.length === 0) return
    const session = await this.sessionFor(conversationId, true)
    if (!session) return
    const branch = await this.branchOf(session)
    if (!branch) return
    for (const message of messages) {
      await branch.appendMessage(message, BACKGROUND_CONTEXT)
    }
  }

  /**
   * 把已压缩的前缀写成 Pi 的 compaction 条目（含保留的尾部），
   * 返回写进去的条目，让会话侧记住它、下一次做增量摘要。
   */
  async recordCompaction(
    conversationId: string,
    compaction: AgentConversationCompaction,
  ): Promise<CompactionEntry | null> {
    const session = await this.sessionFor(conversationId, true)
    if (!session) return null
    const branch = await this.branchOf(session)
    if (!branch) return null
    const parentId = await branch.getTipId(BACKGROUND_CONTEXT)
    const id = session.idGenerator.next()
    const entry = {
      id,
      parentId,
      type: 'compaction' as const,
      summary: compaction.summary,
      retainedTail: [...compaction.retainedTail],
      tokensBefore: compaction.tokensBefore,
      fromHook: false,
    }
    // 和 Pi 的运行层一样：条目写进去之后必须把分支尖端挪到它上面，
    // 否则后续消息会挂在压缩条目之前，压缩就等于没发生过。
    const committed = await session.mutate((mutator) => mutator.commit([
      insertEntry(entry),
      setValue(branchTip(BRANCH_NAME), id),
    ], BACKGROUND_CONTEXT), BACKGROUND_CONTEXT)
    return { ...entry, seq: committed.seqs[0], timestamp: committed.timestamp }
  }

  async delete(conversationId: string): Promise<void> {
    const metadata = await this.metadataFor(conversationId)
    if (!metadata) return
    // 仓库拒绝删除仍打开的会话，先关掉再删。
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

  private async entriesOf(session: Session<JsonlSessionMetadata>): Promise<Entry[]> {
    const branch = await this.branchOf(session)
    if (!branch) return []
    return branch.findEntries({ order: 'oldestFirst' }, BACKGROUND_CONTEXT)
  }

  private async branchOf(session: Session<JsonlSessionMetadata>) {
    const existing = await session.branch(BRANCH_NAME, BACKGROUND_CONTEXT)
    if (existing) return existing
    try {
      return await session.createBranch(BRANCH_NAME, null, BACKGROUND_CONTEXT)
    } catch (error) {
      // 并发创建：另一个调用已经建好分支，直接复用。
      const raced = await session.branch(BRANCH_NAME, BACKGROUND_CONTEXT)
      if (raced) return raced
      logFailure('Agent', 'failed to open conversation branch', error)
      return null
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
        { id: conversationId, cwd: this.projectPath },
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
      const list = await this.repo.list({ cwd: this.projectPath }, BACKGROUND_CONTEXT)
      for (const metadata of list) this.known.set(metadata.id, metadata)
      this.scanned = true
    }
    return this.known.get(conversationId)
  }
}

/**
 * 条目 → 模型上下文。语义与 Pi 的 `harness/session/context.ts`
 * （`buildContextEntries` + `sessionEntryToContextMessages`）一致：最近一条
 * compaction 之前的历史不再逐条保留，只留它的摘要与保留尾部。
 * 这两个函数没有从包里导出，所以在这里按同样规则投影。
 */
export function projectContext(entries: readonly Entry[]): AgentConversationSnapshot {
  let compaction: CompactionEntry | undefined
  let compactionIndex = -1
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry.type === 'compaction') {
      compaction = entry
      compactionIndex = index
      break
    }
  }
  const messages: AgentMessage[] = compaction
    ? [
      createCompactionSummaryMessage(compaction.summary, compaction.tokensBefore, compaction.timestamp),
      ...compaction.retainedTail,
    ]
    : []
  for (const entry of entries.slice(compactionIndex + 1)) {
    if (entry.type === 'message' && isContextMessage(entry.message)) messages.push(entry.message)
  }
  return {
    messages: messages.filter(isContextMessage),
    ...(compaction ? { previousCompaction: compaction } : {}),
  }
}

/** 失败/中止的助手回合不进上下文，与 Pi 的 `isContextMessage` 同规则。 */
function isContextMessage(message: AgentMessage): boolean {
  if (message.role !== 'assistant') return true
  const stopReason = (message as { stopReason?: string }).stopReason
  return stopReason !== 'error' && stopReason !== 'aborted' && stopReason !== 'deferred'
}
