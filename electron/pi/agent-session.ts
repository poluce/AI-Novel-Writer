import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  DEFAULT_COMPACTION_SETTINGS,
  type AgentHarnessOptions,
  type AgentMessage,
  type CompactionSettings,
  type Session,
  type SessionMetadata,
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
import { ConfinedExecutionEnv } from './confined-execution-env'
import { patchGoogleSamplingPayload } from './pi-stream-options'
import type { ResolvedGenerationParameters } from '../llm/generation-parameter-policy'
import { logFailure, logInfo } from '../../src/shared/fail-log'
import { buildL1AgentContext } from './agent-l1-context'
import type { AgentEditorSnapshot, PiAgentEvent, PiToolCallInfo } from '../../src/shared/agent-events'
import type { FileWriteCommitState } from '../../src/shared/ipc-channels'
import type { AgentPromptHistoryTurn } from '../../src/shared/agent-conversation-archive'
import type { WritingLanguage } from '../../src/shared/writing-language'
import type { AgentScope } from '../../src/shared/agent-scope'
import type { AssistantThinkingLevel } from '../../src/shared/agent-runtime'
import type { PiModelRuntime } from './pi-models'

export type { PiAgentEvent } from '../../src/shared/agent-events'

/** 一个会话文件里的唯一 lane；分支/导航能力留给后续产品。 */
export const AGENT_LANE_NAME = 'main'

/**
 * 一个会话的完整工具表 = 领域工具 + harness 执行工具。
 *
 * 创建与每轮 `setTools` 都走这里：lane 的 `activeToolNames` 只在创建时固定一次，
 * 工具表若在后续轮次缩水，harness 的 `activeToolNames ⊆ tools` 校验就会失败。
 */
function composeHarnessTools(
  domainTools: readonly AnyAgentTool[],
  executionEnv: ExecutionEnv | null,
): AnyHarnessTool[] {
  return [
    ...domainTools.map(toHarnessTool),
    ...(executionEnv ? buildExecutionTools() : []),
  ]
}

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
  /**
   * 这次会话解析出的采样参数。harness 自己拥有请求选项，所以 OpenAI 兼容
   * 适配器走 `model.samplingParams`，Gemini 走 `before_payload` 补请求体。
   */
  sampling?: ResolvedGenerationParameters
  /** harness 的思考等级；缺省 `off`，即 Pi 的默认行为。 */
  thinkingLevel?: AssistantThinkingLevel
  /**
   * 产品侧的思考预算补丁是否生效。用户在输入框里显式选了思考等级时为
   * false——那个等级由 harness 直接下发，不该被预算覆盖。
   */
  applySamplingThinking?: boolean
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
  /** 用户显式选了思考等级时为 false，避免预算补丁把它盖掉。 */
  private readonly applySamplingThinking: boolean
  /** 只为旧存档播种时补全 `AssistantMessage` 的元数据。 */
  private readonly model: PiModelRuntime['model']
  /** 执行工具的提交态记录；没有执行环境时为 null。 */
  private readonly commitTracker: ConfinedExecutionEnv | null
  /** 挂 harness 执行工具的执行环境；`setTools` 每轮要用它把执行工具补回来。 */
  private readonly executionEnv: ExecutionEnv | null
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
  /** 执行模式：'plan'（审查计划）| 'writing'（全自动写作） */
  private executionMode: 'plan' | 'writing' = 'plan'
  /** 有一轮生成在跑；`close()` 之外的并发操作靠它判断。 */
  private busy = false
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
    this.applySamplingThinking = options.applySamplingThinking ?? true
    this.executionEnv = options.executionEnv ?? null
    this.commitTracker = options.executionEnv instanceof ConfinedExecutionEnv
      ? options.executionEnv
      : null
    this.registerHooks(options.sampling ?? null)
    this.registerEvents()
  }

  /**
   * 建 harness、挂钩子、取 lane。会话存档由调用方准备好：
   * 项目助手/界面助手各自一个 store，缺失时用内存会话。
   */
  static async create(options: AgentSessionOptions): Promise<AgentSession> {
    const executionEnv = options.executionEnv ?? null
    const tools = composeHarnessTools(options.tools, executionEnv)
    const { harness } = await AgentHarness.create({
      session: options.session,
      models: options.models,
      model: options.model,
      systemPrompt: options.systemPrompt,
      tools,
      ...(executionEnv ? { toolContext: { env: executionEnv } } : {}),
      // 用户没选就是 `off`（Pi 的默认），选了就交给 harness 当思考等级下发。
      thinkingLevel: options.thinkingLevel ?? 'off',
      // 读工具并行；写工具与 MCP 由各自 `executionMode: 'sequential'` 钉住。
      toolExecution: 'parallel',
      compaction: options.compactionSettings ?? DEFAULT_COMPACTION_SETTINGS,
    } as AgentHarnessOptions<HarnessToolContext>, BACKGROUND_CONTEXT)
    const lane = await harness.lane(AGENT_LANE_NAME, BACKGROUND_CONTEXT)
    const session = new AgentSession(options, harness, lane)
    await session.reconcileLaneConfiguration(tools.map(tool => tool.name))
    return session
  }

  /**
   * 打开会话时把 lane 配置对齐到当前运行时。
   *
   * 存档里的 lane 配置是**上一次运行的快照**，而 harness 每次生成前都拿它做校验
   * （`prepareGeneration` 用它查模型、并检查 `activeToolNames ⊆ tools`）。存档里
   * 可能钉着已经删掉的模型，或一份与当前工具表不一致的名单，那样这一轮只会得到
   * "The configured model is unavailable in this process" / "One or more configured
   * tools are unavailable in this process"。这里显式覆盖一次，失败只记日志：
   * 对齐不了时行为与从前一致，不会让会话打不开。
   */
  private async reconcileLaneConfiguration(toolNames: readonly string[]): Promise<void> {
    try {
      await this.lane.setModel(
        { provider: this.model.provider, modelId: this.model.id },
        BACKGROUND_CONTEXT,
      )
      await this.lane.setActiveTools([...toolNames], BACKGROUND_CONTEXT)
    } catch (error) {
      logFailure('Agent', 'failed to reconcile lane configuration', error, {
        conversationId: this.conversationId,
        scope: this.scope,
      })
    }
  }

  // ===== 钩子：领域语义都挂在这里 =====

  private registerHooks(sampling: ResolvedGenerationParameters | null): void {
    // 系统提示词每轮重取（技能目录与项目事实会变），L1 界面快照每轮作为系统动态上下文注入。
    this.unsubscribes.push(this.harness.hooks.on('transform_context', (event) => {
      const l1 = buildL1AgentContext(this.editorSnapshot, this.language)
      const systemPrompt = l1 ? `${this.systemPrompt}\n\n${l1}` : this.systemPrompt
      return {
        messages: event.messages,
        systemPrompt,
      }
    }))

    // Gemini 适配器不读 samplingParams，温度与思考预算只能补进请求体。
    if (sampling && this.model.api === 'google-generative-ai') {
      this.unsubscribes.push(this.harness.hooks.on('before_payload', (event) => ({
        payload: patchGoogleSamplingPayload(event.payload, sampling, {
          applyThinking: this.applySamplingThinking,
        }),
      })))
    }

    // 写工具确认：harness 的钩子先于 tool_start 事件，卡片要在这里补发。
    this.unsubscribes.push(this.harness.hooks.on('before_tool', async (event) => {
      const needsConfirm = this.isConfirmationRequired(event.toolName, event.args as Record<string, unknown> | undefined)
      if (!needsConfirm) return undefined
      const confirmed = await this.requestConfirmation(event.toolCallId, event.toolName, event.args)
      if (confirmed) return undefined
      return { block: { reason: '用户拒绝执行' } }
    }))

    // 工具结果统一截断；「写入了但提交态未知」时终止本轮，避免自动重写。
    // harness 自带的 write / edit 不报提交态，这里按执行环境记录的结果补上，
    // 让它们与领域工具 write_file 走同一条 ADR 0008 保护。
    this.unsubscribes.push(this.harness.hooks.on('after_tool', (event) => {
      const commitState = this.harnessWriteCommitState(event)
      const previousDetails = event.details
      const details = commitState === undefined
        ? previousDetails
        : {
            ...(previousDetails && typeof previousDetails === 'object' && !Array.isArray(previousDetails)
              ? previousDetails
              : {}),
            commitState,
          }
      const commitOverride = afterUnknownCommit({ details })
      return {
        content: truncateToolResultContent(event.content),
        ...(commitState === undefined ? {} : { details }),
        ...(commitOverride?.terminate === undefined ? {} : { terminate: commitOverride.terminate }),
        ...(commitOverride?.isError === undefined ? {} : { isError: commitOverride.isError }),
      }
    }))
  }

  private isConfirmationRequired(toolName: string, args?: Record<string, unknown>): boolean {
    if (toolName.startsWith('mcp__')) return true

    // 写作模式（writing）：创作类工具全部自动放行，零弹窗直接落盘；操作系统级 bash 命令保留底线确认
    if (this.executionMode === 'writing') {
      if (toolName === 'bash') return true
      return false
    }

    // 计划模式（plan）：保持逐项确认
    if (!this.confirmationNames.has(toolName)) return false
    if (toolName === 'propose_chapter_blueprint') {
      const rawAction = String(args?.action ?? '').toLowerCase().trim()
      if (rawAction === 'read' || rawAction === '读取' || rawAction === '查看') {
        return false
      }
    }
    if (toolName === 'novel_config') {
      const rawAction = String(args?.action ?? '').toLowerCase().trim()
      const isExplicitRead = rawAction === 'read' || rawAction === '读取' || rawAction === '查看'
      const isExplicitUpdate = rawAction === 'update' || rawAction === '修改' || rawAction === '更新' || rawAction === '填充'
      const hasUpdatePayload = Boolean(
        args?.changes
        || args?.coreOutline
        || args?.worldSetting
        || args?.goldenFinger
        || args?.protagonistProfile
        || args?.genre
        || args?.subGenre
        || args?.targetAudience
        || args?.totalChapters
        || args?.wordsPerChapter
        || args?.plotStructure
        || args?.narrativePOV
        || args?.globalGuidance
        || args?.writingStyle
        || args?.referenceWorks
        || (args?.field && args?.content),
      )
      if (isExplicitRead || (!isExplicitUpdate && !hasUpdatePayload)) {
        return false
      }
    }
    if (toolName === 'story_architecture') {
      const rawAction = String(args?.action ?? '').toLowerCase().trim()
      const isExplicitRead = rawAction === 'read' || rawAction === '读取' || rawAction === '查看'
      const isExplicitUpdate = rawAction === 'update' || rawAction === '修改' || rawAction === '更新' || rawAction === '填充'
      const hasUpdatePayload = Boolean(
        args?.content
        || args?.premise
        || args?.worldbuilding
        || args?.synopsis,
      )
      if (isExplicitRead || (!isExplicitUpdate && !hasUpdatePayload)) {
        return false
      }
    }
    if (toolName === 'manage_characters') {
      const rawAction = String(args?.action ?? 'read').toLowerCase().trim()
      if (rawAction === 'read' || rawAction === 'track_appearances' || rawAction === '出场追踪' || rawAction === '出场') {
        return false
      }
    }
    if (toolName === 'manage_drafts') {
      const rawAction = String(args?.action ?? 'read').toLowerCase().trim()
      if (
        rawAction === 'read'
        || rawAction === 'list_versions'
        || rawAction === '版本清单'
        || rawAction === '查看版本'
        || rawAction === 'list_annotations'
        || rawAction === '查看标注'
        || rawAction === '标注列表'
        || rawAction === '批注'
      ) {
        return false
      }
    }
    return true
  }

  /**
   * harness 执行工具的提交态：只有「写入失败且无法证明没落地」才回报，
   * 成功与普通失败都不额外标注（成功时模型不需要这行噪音）。
   */
  private harnessWriteCommitState(
    event: { toolName: string; args: Record<string, unknown> },
  ): FileWriteCommitState | undefined {
    if (!this.commitTracker) return undefined
    if (event.toolName !== 'write' && event.toolName !== 'edit') return undefined
    const target = event.args.path
    if (typeof target !== 'string' || !target) return undefined
    return this.commitTracker.consumeUnknownCommit(target) ? 'unknown' : undefined
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

  setExecutionMode(mode?: 'plan' | 'writing'): void {
    this.executionMode = mode === 'writing' ? 'writing' : 'plan'
  }

  /** 技能目录与项目事实每轮重建，下一次请求就会拿到新的系统提示词。 */
  setSystemPrompt(systemPrompt: string): void {
    this.systemPrompt = systemPrompt
  }

  async setTools(tools: AnyAgentTool[]): Promise<void> {
    // 领域工具每轮重建（技能目录、范围会变），但 harness 的执行工具必须一起保留：
    // lane 的 `activeToolNames` 在创建时就固定为完整名单，只设领域工具会让
    // `activeToolNames ⊆ tools` 校验失败，整轮直接以「工具不可用」告终。
    await this.harness.setTools(composeHarnessTools(tools, this.executionEnv), BACKGROUND_CONTEXT)
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
    this.busy = true
    try {
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
    } finally {
      this.busy = false
    }
  }

  /** 是否有一轮生成正在进行；换模型/思考等级要重建会话时用它判断能不能安全关掉。 */
  isBusy(): boolean {
    return this.busy
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

  /**
   * 关掉 harness；成功与否都要让调用方知道。
   *
   * harness 在一轮操作还在跑时会拒绝关闭（`HarnessClosed`）。此时不能假装已经
   * 关掉——调用方要据此拒绝重建会话，否则两个 harness 会同时打开同一个存档。
   */
  async close(): Promise<boolean> {
    if (this.closed) return true
    this.closed = true
    for (const pending of this.pendingConfirmations.values()) pending.resolve(false)
    this.pendingConfirmations.clear()
    for (const unsubscribe of this.unsubscribes) unsubscribe()
    try {
      await this.harness.close(BACKGROUND_CONTEXT)
      return true
    } catch (error) {
      logFailure('Agent', 'failed to close agent harness', error, {
        conversationId: this.conversationId,
        scope: this.scope,
      })
      return false
    }
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
