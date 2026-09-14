import {
  BACKGROUND_CONTEXT,
  DEFAULT_COMPACTION_SETTINGS,
  compact,
  createCompactionSummaryMessage,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
  type AgentMessage,
  type CompactionEntry,
  type CompactionSettings,
  type Entry,
  type MessageEntry,
  type StreamFn,
} from '@earendil-works/pi-agent-core'
import type { Models } from '@earendil-works/pi-ai'

import {
  createPiAgent,
  type PiAgentHandle,
} from './pi-agent'
import { withCompactionCallAccounting } from './llm-call-accounting'
import type { AgentConversationStore } from './agent-conversation-store'
import { logFailure, logInfo } from '../../src/shared/fail-log'
import { buildL1AgentContext } from './agent-l1-context'
import type { AgentEditorSnapshot, PiAgentEvent } from '../../src/shared/agent-events'
import type { AgentPromptHistoryTurn } from '../../src/shared/agent-conversation-archive'
import type { WritingLanguage } from '../../src/shared/writing-language'
import type { AnyAgentTool } from './tool-types'
import type { PiModelRuntime } from './pi-models'

export type { PiAgentEvent } from '../../src/shared/agent-events'

export interface AgentSessionOptions {
  /** Pre-built pi-ai runtime (see `createPiModels`). */
  model: PiModelRuntime['model']
  /** Same runtime's model collection; Pi's compaction calls it directly. */
  models: Models
  streamFn: StreamFn
  systemPrompt: string
  tools: AnyAgentTool[]
  confirmationToolNames?: ReadonlySet<string>
  language: WritingLanguage
  /** Emit a normalized event toward the renderer (IPC send in production). */
  emit: (event: PiAgentEvent) => void
  /** Durable Pi session for this conversation; absent means memory-only. */
  store?: AgentConversationStore
  conversationId?: string
  /** Pi's own compaction thresholds. Defaults to `DEFAULT_COMPACTION_SETTINGS`. */
  compactionSettings?: CompactionSettings
}

/**
 * One long-lived Pi Agent session (main process). Bridges the Agent's
 * normalized callbacks to renderer events and turns tool confirmation into a
 * request/response round-trip: `confirm()` resolves the pending `beforeToolCall`.
 */
export class AgentSession {
  private readonly agent: PiAgentHandle
  private readonly pendingConfirmations = new Map<string, (confirmed: boolean) => void>()
  private editorSnapshot: AgentEditorSnapshot | null = null
  private systemPrompt: string
  private readonly language: WritingLanguage
  private readonly model: PiModelRuntime['model']
  private readonly models: Models
  private readonly store: AgentConversationStore | null
  private readonly conversationId: string | null
  private readonly compactionSettings: CompactionSettings
  /** 已写进 Pi 会话的消息条数，避免重复追加。 */
  private persistedCount = 0
  /** 最近一次压缩条目；下一次压缩据此增量更新摘要。 */
  private previousCompaction: CompactionEntry | null = null

  constructor(options: AgentSessionOptions) {
    this.language = options.language
    this.systemPrompt = options.systemPrompt
    this.model = options.model
    this.models = options.models
    this.store = options.store ?? null
    this.conversationId = options.conversationId ?? null
    this.compactionSettings = options.compactionSettings ?? DEFAULT_COMPACTION_SETTINGS
    this.agent = createPiAgent({
      model: options.model,
      streamFn: options.streamFn,
      systemPrompt: options.systemPrompt,
      tools: options.tools,
      confirmationToolNames: options.confirmationToolNames,
      transformContext: async (messages) => this.injectL1(messages),
      callbacks: {
        onTextChunk: (chunk) => options.emit({ type: 'text_delta', delta: chunk }),
        onToolCallStart: (call) => options.emit({ type: 'tool_call_start', call }),
        onToolCallConfirmRequired: (call) => new Promise<boolean>((resolve) => {
          this.pendingConfirmations.set(call.id, resolve)
          options.emit({ type: 'tool_call_confirm', call })
        }),
        onToolCallComplete: (call) => options.emit({ type: 'tool_call_complete', call }),
        onDone: (fullText) => options.emit({ type: 'done', fullText }),
        onError: (message) => options.emit({ type: 'error', message }),
      },
    })
  }

  setEditorSnapshot(snapshot: AgentEditorSnapshot | null | undefined): void {
    this.editorSnapshot = snapshot ?? null
  }

  async prompt(input: string): Promise<void> {
    await this.compactIfNeeded()
    await this.agent.prompt(input)
    await this.persistNewMessages()
  }

  /**
   * 从 Pi 会话存档恢复模型上下文（含工具回合与压缩条目）。
   * 返回是否真的恢复出了内容，让调用方决定要不要退回旧的历史。
   */
  restoreSnapshot(snapshot: { messages: AgentMessage[]; previousCompaction?: CompactionEntry }): boolean {
    if (snapshot.messages.length === 0) return false
    this.agent.restoreMessages([...snapshot.messages])
    this.persistedCount = snapshot.messages.length
    this.previousCompaction = snapshot.previousCompaction ?? null
    return true
  }

  restoreHistory(history: readonly AgentPromptHistoryTurn[]): void {
    if (history.length === 0) return
    const messages = history.map((turn) => (
      turn.role === 'assistant'
        ? {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: turn.content }],
          timestamp: Date.now(),
        }
        : {
          role: 'user' as const,
          content: turn.content,
          timestamp: Date.now(),
        }
    )) as AgentMessage[]
    this.agent.restoreMessages(messages)
    this.persistedCount = messages.length
    // 旧存档是丢结构的历史：当作已入档，避免把种子再写一遍。
    void this.store?.appendMessages(this.conversationId ?? '', messages)
  }

  setTools(tools: AnyAgentTool[]): void {
    this.agent.setTools(tools)
  }

  /**
   * Refresh the system prompt on the live session. The skill catalog and L0
   * project facts are rebuilt per turn, so the next request picks up a newly
   * installed skill without restarting the conversation.
   */
  setSystemPrompt(systemPrompt: string): void {
    if (systemPrompt === this.systemPrompt) return
    this.systemPrompt = systemPrompt
    this.agent.setSystemPrompt(systemPrompt)
  }

  private injectL1(messages: AgentMessage[]): AgentMessage[] {
    const l1 = buildL1AgentContext(this.editorSnapshot, this.language)
    if (!l1) return messages
    const injected: AgentMessage = { role: 'user', content: l1, timestamp: Date.now() }
    if (messages.length === 0) return [injected]
    return [...messages.slice(0, -1), injected, messages[messages.length - 1]]
  }

  /**
   * 上下文压缩：用 Pi 的阈值判断 + Pi 的摘要提示词，把超窗口的历史收成
   * 一条 compactionSummary（加保留的尾部）。在每轮开始前判断，绝不在一轮
   * 中间改上下文。压缩失败只记日志——宁可带着长上下文再试一次。
   */
  private async compactIfNeeded(): Promise<void> {
    if (!this.compactionSettings.enabled) return
    const messages = this.agent.messages
    if (messages.length === 0) return
    const contextWindow = Number((this.model as { contextWindow?: number }).contextWindow ?? 0)
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) return
    const { tokens } = estimateContextTokens(messages)
    if (!shouldCompact(tokens, contextWindow, this.compactionSettings)) return

    const preparation = prepareCompaction(
      this.compactionEntries(messages),
      this.compactionSettings,
    )
    if (!preparation.ok) {
      logFailure('Agent', 'compaction preparation failed', undefined, {
        conversationId: this.conversationId,
        error: String(preparation.error),
      })
      return
    }
    if (!preparation.value) return

    const result = await compact(
      preparation.value,
      withCompactionCallAccounting(this.models),
      this.model,
      undefined,
      undefined,
      undefined,
      undefined,
      // 压缩是后台上下文维护，不跟随某一次用户请求的取消。
      BACKGROUND_CONTEXT,
    )
    if (!result.ok) {
      logFailure('Agent', 'compaction failed', undefined, {
        conversationId: this.conversationId,
        error: String(result.error),
      })
      return
    }

    const { summary, tokensBefore, retainedTail } = result.value
    const timestamp = Date.now()
    this.agent.restoreMessages([
      createCompactionSummaryMessage(summary, tokensBefore, timestamp),
      ...retainedTail,
    ])
    logInfo('Agent', 'compacted conversation context', {
      conversationId: this.conversationId,
      tokensBefore,
      tokensAfter: estimateContextTokens(this.agent.messages).tokens,
      keptMessages: retainedTail.length,
    })
    if (!this.store || !this.conversationId) return
    try {
      await this.store.recordCompaction(this.conversationId, { summary, tokensBefore, retainedTail })
      // 存档里 compaction 条目已经代表整个前缀，计数器从摘要+尾部重新起算。
      this.persistedCount = this.agent.messages.length
      this.previousCompaction = null
    } catch (error) {
      logFailure('Agent', 'failed to persist compaction', error, {
        conversationId: this.conversationId,
      })
    }
  }

  /**
   * 把在内存消息折成 Pi 的条目序列喂给 `prepareCompaction`：它按回合切分，
   * 需要 `Entry` 形态；上一次的 compaction 条目也带上，好做增量摘要。
   */
  private compactionEntries(messages: readonly AgentMessage[]): Entry[] {
    const entries: Entry[] = []
    let parentId: string | null = null
    let seq = 0
    if (this.previousCompaction) {
      entries.push(this.previousCompaction)
      parentId = this.previousCompaction.id
      seq = this.previousCompaction.seq + 1
    }
    for (const message of messages) {
      const entry: MessageEntry = {
        id: `memory-${seq}`,
        parentId,
        seq,
        timestamp: (message as { timestamp?: number }).timestamp ?? Date.now(),
        type: 'message',
        message,
      }
      entries.push(entry)
      parentId = entry.id
      seq += 1
    }
    return entries
  }

  /** 把这一轮新增的消息追加进 Pi 会话存档（尽力而为）。 */
  private async persistNewMessages(): Promise<void> {
    if (!this.store || !this.conversationId) return
    const messages = this.agent.messages
    if (messages.length <= this.persistedCount) return
    const fresh = messages.slice(this.persistedCount)
    this.persistedCount = messages.length
    try {
      await this.store.appendMessages(this.conversationId, fresh)
    } catch (error) {
      // 存档失败不回滚计数器以外的任何东西：下一轮会补齐后续消息。
      logFailure('Agent', 'failed to persist conversation messages', error, {
        conversationId: this.conversationId,
      })
    }
  }

  /** Resolve a pending tool confirmation from the renderer. */
  confirm(toolCallId: string, confirmed: boolean): void {
    const resolve = this.pendingConfirmations.get(toolCallId)
    if (resolve) {
      this.pendingConfirmations.delete(toolCallId)
      resolve(confirmed)
    }
  }

  abort(): void {
    this.agent.abort()
  }

  get messages(): AgentMessage[] {
    return this.agent.messages
  }
}
