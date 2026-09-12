import { Agent } from '@earendil-works/pi-agent-core'
import type {
  AgentMessage,
  AgentTool,
  StreamFn,
} from '@earendil-works/pi-agent-core'
import type { Model } from '@earendil-works/pi-ai'
import { logFailure, logInfo } from '../../src/shared/fail-log'

import type { ModelProfile } from '../../src/shared/ipc-channels'
import type { PiToolCallInfo } from '../../src/shared/agent-events'
import { afterUnknownCommit } from './commit-state'
import { withLlmCallAccounting } from './llm-call-accounting'
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

function assistantPlainText(message: AgentMessage | undefined): string {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block): block is { type: 'text'; text: string } => (
      typeof block === 'object'
      && block !== null
      && 'type' in block
      && block.type === 'text'
      && 'text' in block
      && typeof block.text === 'string'
    ))
    .map(block => block.text)
    .join('')
}

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
    streamFn: withLlmCallAccounting(options.streamFn),
    transformContext: options.transformContext,
    toolExecution: 'sequential',
    beforeToolCall: async (ctx) => {
      const call = toolCalls.get(ctx.toolCall.id)
      const needsConfirm = confirmationNames.has(ctx.toolCall.name)
        || ctx.toolCall.name.startsWith('mcp__')
      if (!call || !needsConfirm) return undefined
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
    afterToolCall: async (ctx) => afterUnknownCommit(ctx.result),
  })

  agent.subscribe((event) => {
    switch (event.type) {
      case 'message_update': {
        const ev = event.assistantMessageEvent
        if (ev.type === 'text_delta') {
          fullText += ev.delta
          callbacks.onTextChunk(ev.delta)
        } else if (ev.type === 'error') {
          logFailure('Agent', 'stream error event', undefined, {
            errorMessage: ev.error.errorMessage,
            stopReason: ev.error.stopReason,
          })
          callbacks.onError(ev.error.errorMessage ?? '生成失败')
        }
        break
      }
      case 'message_end': {
        if (!fullText) fullText = assistantPlainText(event.message)
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
        logInfo('AgentTool', 'start', { toolName: event.toolName, toolCallId: event.toolCallId })
        callbacks.onToolCallStart(call)
        break
      }
      case 'tool_execution_end': {
        const call = toolCalls.get(event.toolCallId)
        if (!call) break
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
        callbacks.onToolCallComplete(call)
        break
      }
      case 'agent_end': {
        const lastAssistant = [...event.messages].reverse().find(message => message.role === 'assistant')
        if (!fullText) fullText = assistantPlainText(lastAssistant)
        const stopReason = lastAssistant && 'stopReason' in lastAssistant ? lastAssistant.stopReason : undefined
        const errorMessage = lastAssistant && 'errorMessage' in lastAssistant
          ? lastAssistant.errorMessage
          : undefined
        logInfo('Agent', 'agent_end', {
          fullTextChars: fullText.length,
          stopReason,
          messageCount: event.messages.length,
        })
        if (stopReason === 'error' || stopReason === 'aborted') {
          logFailure('Agent', 'agent ended with encoded stream failure', undefined, {
            stopReason,
            errorMessage,
          })
          callbacks.onError(errorMessage || '生成失败')
          break
        }
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
