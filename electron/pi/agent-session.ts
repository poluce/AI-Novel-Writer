import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  DEFAULT_COMPACTION_SETTINGS,
  type AgentHarnessOptions,
  type AgentMessage,
  type CompactionSettings,
  type Session,
  type SessionMetadata,
  type Skill,
  type PromptTemplate,
} from '@earendil-works/pi-agent-core'
import type { Models } from '@earendil-works/pi-ai'
import type { ExecutionEnv } from '@earendil-works/pi-agent-core'

import { recordAgentCall, recordAgentFailure } from './llm-call-accounting'
import { afterUnknownCommit } from './commit-state'
import { truncateToolResultContent } from './tool-result'
import {
  toHarnessTool,
  type AnyAgentTool,
  type AnyHarnessTool,
  type HarnessToolContext,
} from './tool-types'
import { buildExecutionTools } from './execution-tools'
import { logFailure, logInfo } from '../../src/shared/fail-log'
import { buildL1AgentContext } from './agent-l1-context'
import type { AgentEditorSnapshot, PiAgentEvent, PiToolCallInfo } from '../../src/shared/agent-events'
import type { AgentPromptHistoryTurn } from '../../src/shared/agent-conversation-archive'
import type { WritingLanguage } from '../../src/shared/writing-language'
import type { AgentScope } from '../../src/shared/agent-scope'
import type { PiModelRuntime } from './pi-models'

export type { PiAgentEvent } from '../../src/shared/agent-events'

/** 一个会话文件里的唯一 lane；分支/导航能力留给后续产品。 */
export const AGENT_LANE_NAME = 'main'

export interface AgentSessionOptions {
  /** 这次会话的 pi-ai 运行时；harness 直接用它发请求。 */
  models: Models
  model: PiModelRuntime['model']
  /** `llm_calls` 记账用的模型身份。 */
  modelIdentity: { modelId: string; modelName: string }
  systemPrompt: string
  tools: AnyAgentTool[]
  /** 执行前必须用户确认的工具名。 */
  confirmationToolNames?: ReadonlySet<string>
  /** 有它才挂 Pi harness 的执行工具（read / write / edit / bash）。 */
  executionEnv?: ExecutionEnv | null
  /** 技能与提示词模板：交给 harness 的资源表（`lane.skill()` 的查找来源）。 */
  resources?: { skills?: Skill[]; promptTemplates?: PromptTemplate[] }
  language: WritingLanguage
  /** Emit a normalized event toward the renderer (IPC send in production). */
  emit: (event: PiAgentEvent) => void
  /** Durable harness session for this conversation. */
  session: Session<SessionMetadata>
  conversationId?: string
  /** 项目助手 / 界面助手；只影响日志与后续扩展。 */
  scope?: AgentScope
  /** Pi 的压缩阈值；默认与库一致。 */
  compactionSettings?: CompactionSettings
}

interface PendingConfirmation {
  resolve: (confirmed: boolean) => void
  call: PiToolCallInfo
}

/**
 * 一个长期存活的 Pi Agent 会话（主进程）。
 *
 * 编排（会话条目、上下文投影、压缩、工具执行与确认钩子、usage 记账、
 * 中断）全部由 `AgentHarness` 承担；这一层只做两件事：
 * 1. 把 harness 的事件流翻译成渲染层的 `PiAgentEvent` 协议；
 * 2. 挂上本应用的领域语义——L1 界面快照注入、写工具确认往返、
 *    工具结果截断与「未知提交态不重试」。
 */
export class AgentSession {
  private readonly harness: AgentHarness<HarnessToolContext>
  private readonly lane: Awaited<ReturnType<AgentHarness<undefined>['lane']>>
  private readonly emit: (event: PiAgentEvent) => void
  private readonly language: WritingLanguage
  private readonly scope: AgentScope
  private readonly conversationId: string | null
  private readonly confirmationNames: ReadonlySet<string>
  private readonly modelIdentity: { modelId: string; modelName: string }
  /** 只为旧存档播种时补全 `AssistantMessage` 的元数据。 */
  private readonly model: PiModelRuntime['model']
  private readonly unsubscribes: Array<() => void> = []

  private editorSnapshot: AgentEditorSnapshot | null = null
  /** 最近一次模型请求的开始时间，用于 `llm_calls` 的耗时统计。 */
  private requestStartedAt: number | null = null
  private systemPrompt: string
  private readonly pendingConfirmations = new Map<string, PendingConfirmation>()
  /** 工具卡状态：确认与结束事件都要回填同一张卡。 */
  private readonly toolCalls = new Map<string, PiToolCallInfo>()
  /** before_tool 已经替 tool_start 发过卡片的调用，避免重复发。 */
  private readonly announcedToolCalls = new Set<string>()
  /** 当前这一轮累积的可见文本；工具回合之间的正文按顺序拼接。 */
  private fullText = ''
  private closed = false

  private constructor(
    options: AgentSessionOptions,
    harness: AgentHarness<HarnessToolContext>,
    lane: Awaited<ReturnType<AgentHarness<HarnessToolContext>['lane']>>,
  ) {
    this.harness = harness
    this.lane = lane
    this.emit = options.emit
    this.language = options.language
    this.scope = options.scope ?? 'project'
    this.conversationId = options.conversationId ?? null
    this.confirmationNames = options.confirmationToolNames ?? new Set<string>()
    this.systemPrompt = options.systemPrompt
    this.modelIdentity = options.modelIdentity
    this.model = options.model
    this.registerHooks()
    this.registerEvents()
  }

  /**
   * 建 harness、挂钩子、取 lane。会话存档由调用方准备好：
   * 项目助手/界面助手各自一个 store，缺失时用内存会话。
   */
  static async create(options: AgentSessionOptions): Promise<AgentSession> {
    const executionEnv = options.executionEnv ?? null
    const tools: AnyHarnessTool[] = [
      ...options.tools.map(toHarnessTool),
      ...(executionEnv ? buildExecutionTools() : []),
    ]
    const { harness } = await AgentHarness.create({
      session: options.session,
      models: options.models,
      model: options.model,
      systemPrompt: options.systemPrompt,
      tools,
      ...(executionEnv ? { toolContext: { env: executionEnv } } : {}),
      // 读工具并行；写工具与 MCP 由各自 `executionMode: 'sequential'` 钉住。
      toolExecution: 'parallel',
      compaction: options.compactionSettings ?? DEFAULT_COMPACTION_SETTINGS,
      ...(options.resources ? { resources: options.resources } : {}),
    } as AgentHarnessOptions<HarnessToolContext>, BACKGROUND_CONTEXT)
    const lane = await harness.lane(AGENT_LANE_NAME, BACKGROUND_CONTEXT)
    return new AgentSession(options, harness, lane)
  }

  // ===== 钩子：领域语义都挂在这里 =====

  private registerHooks(): void {
    // 系统提示词每轮重取（技能目录与项目事实会变），L1 界面快照每轮注入。
    this.unsubscribes.push(this.harness.hooks.on('transform_context', (event) => ({
      messages: this.injectL1(event.messages),
      systemPrompt: this.systemPrompt,
    })))

    // 写工具确认：harness 的钩子先于 tool_start 事件，卡片要在这里补发。
    this.unsubscribes.push(this.harness.hooks.on('before_tool', async (event) => {
      const needsConfirm = this.confirmationNames.has(event.toolName)
        || event.toolName.startsWith('mcp__')
      if (!needsConfirm) return undefined
      const confirmed = await this.requestConfirmation(event.toolCallId, event.toolName, event.args)
      if (confirmed) return undefined
      return { block: { reason: '用户拒绝执行' } }
    }))

    // 工具结果统一截断；「写入了但提交态未知」时终止本轮，避免自动重写。
    this.unsubscribes.push(this.harness.hooks.on('after_tool', (event) => {
      const commitOverride = afterUnknownCommit({ details: event.details })
      return {
        content: truncateToolResultContent(event.content),
        ...(commitOverride?.terminate === undefined ? {} : { terminate: commitOverride.terminate }),
        ...(commitOverride?.isError === undefined ? {} : { isError: commitOverride.isError }),
      }
    }))
  }

  private requestConfirmation(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    const call = this.toolCalls.get(toolCallId) ?? {
      id: toolCallId,
      toolName,
      arguments: args,
      status: 'running' as const,
    }
    call.status = 'waiting_confirm'
    this.toolCalls.set(toolCallId, call)
    // harness 的 before_tool 先于 tool_start：卡片必须先于确认请求到达渲染层。
    if (!this.announcedToolCalls.has(toolCallId)) {
      this.announcedToolCalls.add(toolCallId)
      this.emit({ type: 'tool_call_start', call })
    }
    return new Promise<boolean>((resolve) => {
      this.pendingConfirmations.set(toolCallId, { resolve, call })
      this.emit({ type: 'tool_call_confirm', call })
    })
  }

  // ===== 事件：harness → 渲染层协议 =====

  private registerEvents(): void {
    const events = this.harness.events
    this.unsubscribes.push(events.on('message_update', (event) => {
      const update = event.event
      if (update.type === 'text_delta') {
        this.fullText += update.delta
        this.emit({ type: 'text_delta', delta: update.delta })
        return
      }
      if (update.type === 'error') {
        logFailure('Agent', 'stream error event', undefined, {
          conversationId: this.conversationId,
          scope: this.scope,
          errorMessage: update.error.errorMessage,
          stopReason: update.error.stopReason,
        })
        this.emit({ type: 'error', message: update.error.errorMessage ?? '生成失败' })
      }
    }))

    this.unsubscribes.push(events.on('tool_start', (event) => {
      const call: PiToolCallInfo = {
        id: event.toolCallId,
        toolName: event.toolName,
        arguments: event.args,
        status: 'running',
      }
      this.toolCalls.set(event.toolCallId, call)
      logInfo('AgentTool', 'start', { toolName: event.toolName, toolCallId: event.toolCallId })
      if (this.announcedToolCalls.has(event.toolCallId)) return
      this.announcedToolCalls.add(event.toolCallId)
      this.emit({ type: 'tool_call_start', call })
    }))

    this.unsubscribes.push(events.on('tool_end', (event) => {
      const call = this.toolCalls.get(event.toolCallId)
      if (!call) return
      call.status = event.isError ? 'failed' : 'completed'
      call.result = event.result?.details
      if (event.isError) {
        call.error = toolResultErrorText(event.result)
        logFailure('AgentTool', 'failed', undefined, {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          error: call.error,
        })
      } else {
        logInfo('AgentTool', 'completed', { toolName: event.toolName, toolCallId: event.toolCallId })
      }
      this.emit({ type: 'tool_call_complete', call })
    }))

    this.unsubscribes.push(this.harness.hooks.on('before_request', () => {
      this.requestStartedAt = Date.now()
      return undefined
    }))

    // 每次请求一行 llm_calls；压缩与结构化摘要这类嵌套请求同样会发 usage 事件。
    this.unsubscribes.push(events.on('usage', (event) => {
      const startedAt = this.requestStartedAt ?? Date.now()
      this.requestStartedAt = null
      recordAgentCall(this.modelIdentity, event.row.usage, startedAt, true)
    }))

    this.unsubscribes.push(events.on('run_end', (event) => {
      if (event.status === 'failed') {
        const message = event.error?.message ?? '生成失败'
        recordAgentFailure(this.modelIdentity, message)
        logFailure('Agent', 'run failed', undefined, {
          conversationId: this.conversationId,
          scope: this.scope,
          error: message,
        })
        this.emit({ type: 'error', message })
        return
      }
      if (event.status === 'aborted') {
        recordAgentFailure(this.modelIdentity, 'aborted')
        this.emit({ type: 'error', message: '生成已中断' })
        return
      }
      logInfo('Agent', 'run completed', {
        conversationId: this.conversationId,
        scope: this.scope,
        fullTextChars: this.fullText.length,
      })
      this.emit({ type: 'done', fullText: this.fullText })
    }))
  }

  // ===== 对外接口 =====

  setEditorSnapshot(snapshot: AgentEditorSnapshot | null | undefined): void {
    this.editorSnapshot = snapshot ?? null
  }

  /** 技能目录与项目事实每轮重建，下一次请求就会拿到新的系统提示词。 */
  setSystemPrompt(systemPrompt: string): void {
    this.systemPrompt = systemPrompt
  }

  async setTools(tools: AnyAgentTool[]): Promise<void> {
    await this.harness.setTools(tools.map(toHarnessTool), BACKGROUND_CONTEXT)
  }

  async setResources(resources: { skills?: Skill[]; promptTemplates?: PromptTemplate[] }): Promise<void> {
    await this.harness.setResources(resources, BACKGROUND_CONTEXT)
  }

  /** 存档里已有的条目条数；0 表示这是一段全新的会话。 */
  async transcriptLength(): Promise<number> {
    const entries = await this.lane.findEntries({ order: 'oldestFirst' }, BACKGROUND_CONTEXT)
    return entries.length
  }

  /**
   * 旧存档（渲染层纯文本历史）灌进空会话：有 Pi 会话文件时以文件为准，
   * 只有文件缺失才走这里。
   */
  async seedHistory(history: readonly AgentPromptHistoryTurn[]): Promise<void> {
    if (history.length === 0) return
    try {
      for (const turn of history) {
        await this.lane.appendMessage(this.historyMessage(turn), BACKGROUND_CONTEXT)
      }
      logInfo('Agent', 'seeded conversation from renderer history', {
        conversationId: this.conversationId,
        scope: this.scope,
        turns: history.length,
      })
    } catch (error) {
      logFailure('Agent', 'failed to seed conversation session', error, {
        conversationId: this.conversationId,
        scope: this.scope,
      })
    }
  }

  /**
   * 旧存档只有纯文本：助手回合也要补成完整的 `AssistantMessage`，
   * 否则 Pi 的上下文投影会把它当成非法消息。它是历史种子，不参与记账。
   */
  private historyMessage(turn: AgentPromptHistoryTurn): AgentMessage {
    if (turn.role !== 'assistant') {
      return { role: 'user', content: turn.content, timestamp: Date.now() }
    }
    return {
      role: 'assistant',
      content: [{ type: 'text', text: turn.content }],
      api: this.model.api,
      provider: this.model.provider,
      model: this.model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: Date.now(),
    }
  }

  async prompt(input: string): Promise<void> {
    this.fullText = ''
    const result = await this.lane.prompt(input, undefined, BACKGROUND_CONTEXT)
    if (!result.ok) {
      const message = result.error.message || String(result.error)
      recordAgentFailure(this.modelIdentity, message)
      logFailure('Agent', 'prompt rejected', undefined, {
        conversationId: this.conversationId,
        scope: this.scope,
        error: message,
      })
      this.emit({ type: 'error', message })
    }
  }

  /** Resolve a pending tool confirmation from the renderer. */
  confirm(toolCallId: string, confirmed: boolean): void {
    const pending = this.pendingConfirmations.get(toolCallId)
    if (!pending) return
    this.pendingConfirmations.delete(toolCallId)
    pending.resolve(confirmed)
  }

  abort(): void {
    for (const pending of this.pendingConfirmations.values()) pending.resolve(false)
    this.pendingConfirmations.clear()
    void this.lane.abort(BACKGROUND_CONTEXT).catch((error) => {
      logFailure('Agent', 'failed to abort agent run', error, {
        conversationId: this.conversationId,
        scope: this.scope,
      })
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pendingConfirmations.values()) pending.resolve(false)
    this.pendingConfirmations.clear()
    for (const unsubscribe of this.unsubscribes) unsubscribe()
    try {
      await this.harness.close(BACKGROUND_CONTEXT)
    } catch (error) {
      logFailure('Agent', 'failed to close agent harness', error, {
        conversationId: this.conversationId,
        scope: this.scope,
      })
    }
  }

  private injectL1(messages: AgentMessage[]): AgentMessage[] {
    const l1 = buildL1AgentContext(this.editorSnapshot, this.language)
    if (!l1) return messages
    const injected: AgentMessage = { role: 'user', content: l1, timestamp: Date.now() }
    if (messages.length === 0) return [injected]
    return [...messages.slice(0, -1), injected, messages[messages.length - 1]]
  }
}

/** 工具失败时给渲染层的原因文本。 */
function toolResultErrorText(result: unknown): string {
  if (!result || typeof result !== 'object') return '工具执行失败'
  const record = result as {
    details?: unknown
    content?: Array<{ type?: string; text?: string }>
  }
  if (typeof record.details === 'string' && record.details.trim()) return record.details
  const text = (record.content ?? [])
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
  return text || '工具执行失败'
}
