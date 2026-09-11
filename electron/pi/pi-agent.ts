import { Agent } from '@earendil-works/pi-agent-core'
import type {
  AgentMessage,
  AgentTool,
  StreamFn,
} from '@earendil-works/pi-agent-core'
import type { Model } from '@earendil-works/pi-ai'

import type { ModelProfile } from '../../src/shared/ipc-channels'
import type { PiToolCallInfo } from '../../src/shared/agent-events'
import { createPiModels } from './pi-models'

export type { PiToolCallInfo } from '../../src/shared/agent-events'

/** Normalized UI callback contract — mirrors the renderer agent engine. */
export interface PiAgentCallbacks {
  onTextChunk: (chunk: string) => void
  onToolCallStart: (call: PiToolCallInfo) => void
  /** Await user confirmation; resolve `true` to run, `false` to block. */
  onToolCallConfirmRequired: (call: PiToolCallInfo) => Promise<boolean>
  onToolCallComplete: (call: PiToolCallInfo) => void
  onDone: (fullText: string) => void
  onError: (message: string) => void
}

export interface CreatePiAgentOptions {
  /** Pre-built pi-ai runtime (see `createPiModels`). */
  model: Model<any>
  streamFn: StreamFn
  systemPrompt: string
  tools: AgentTool<any>[]
  /** Tool names that must be confirmed by the user before execution. */
  confirmationToolNames?: ReadonlySet<string>
  /** Inject ephemeral context (L1 editor snapshot) before convertToLlm. */
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>
  callbacks: PiAgentCallbacks
}

export interface PiAgentHandle {
  prompt(input: string): Promise<void>
  abort(): void
  setTools(tools: AgentTool<any>[]): void
  messages: AgentMessage[]
}

/**
 * Wrap a pi-agent-core Agent and map its event stream onto the app's
 * normalized callback contract (text deltas, tool cards, confirmation,
 * completion, done/error).
 */
export function createPiAgent(options: CreatePiAgentOptions): PiAgentHandle {
  const { callbacks } = options
  const confirmationNames = options.confirmationToolNames ?? new Set<string>()
  const toolCalls = new Map<string, PiToolCallInfo>()
  let fullText = ''

  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model: options.model,
      tools: options.tools,
      messages: [],
    },
    streamFn: options.streamFn,
    transformContext: options.transformContext,
    beforeToolCall: async (ctx) => {
      const call = toolCalls.get(ctx.toolCall.id)
      if (!call || !confirmationNames.has(ctx.toolCall.name)) return undefined
      call.status = 'waiting_confirm'
      const confirmed = await callbacks.onToolCallConfirmRequired(call)
      if (!confirmed) {
        call.status = 'failed'
        call.error = '用户拒绝执行'
        return { block: true, reason: '用户拒绝执行' }
      }
      call.status = 'running'
      return undefined
    },
  })

  agent.subscribe((event) => {
    switch (event.type) {
      case 'message_update': {
        const ev = event.assistantMessageEvent
        if (ev.type === 'text_delta') {
          fullText += ev.delta
          callbacks.onTextChunk(ev.delta)
        } else if (ev.type === 'error') {
          callbacks.onError(ev.error.errorMessage ?? '生成失败')
        }
        break
      }
      case 'tool_execution_start': {
        const call: PiToolCallInfo = {
          id: event.toolCallId,
          toolName: event.toolName,
          arguments: event.args,
          status: 'running',
        }
        toolCalls.set(event.toolCallId, call)
        callbacks.onToolCallStart(call)
        break
      }
      case 'tool_execution_end': {
        const call = toolCalls.get(event.toolCallId)
        if (!call) break
        call.status = event.isError ? 'failed' : 'completed'
        call.result = event.result?.details
        if (event.isError) call.error = String(event.result?.details ?? '工具执行失败')
        callbacks.onToolCallComplete(call)
        break
      }
      case 'agent_end': {
        callbacks.onDone(fullText)
        break
      }
      default:
        break
    }
  })

  return {
    prompt: async (input) => {
      fullText = ''
      await agent.prompt(input)
    },
    abort: () => agent.abort(),
    setTools: (tools) => {
      agent.state.tools = tools
    },
    get messages() {
      return agent.state.messages
    },
  }
}

/** Build a Pi Agent directly from a persisted model profile. */
export function createPiAgentForProfile(options: {
  profile: ModelProfile
  systemPrompt: string
  tools: AgentTool<any>[]
  confirmationToolNames?: ReadonlySet<string>
  callbacks: PiAgentCallbacks
}): PiAgentHandle {
  const { models, model } = createPiModels(options.profile)
  return createPiAgent({
    model,
    streamFn: models.streamSimple.bind(models),
    systemPrompt: options.systemPrompt,
    tools: options.tools,
    confirmationToolNames: options.confirmationToolNames,
    callbacks: options.callbacks,
  })
}
