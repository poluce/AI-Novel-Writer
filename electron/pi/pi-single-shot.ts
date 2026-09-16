import { randomUUID } from 'node:crypto'

import {
  isContextOverflow,
  parseJsonWithRepair,
  validateToolCall,
  type Api,
  type AssistantMessage,
  type Message,
  type ProviderId,
  type Tool,
} from '@earendil-works/pi-ai'

import { acquirePiOneShotSlot, registerPiInFlight } from './in-flight'
import { createPiModels } from './pi-models'

import type { LLMFinishReason, ModelProfile } from '../../src/shared/ipc-channels'
import type { AnyAgentTool } from './tool-types'

export interface SingleShotResult {
  /** Validated submit_* arguments, or undefined when the model returned text only. */
  artifact: Record<string, unknown> | undefined
  /** Visible text accumulated from the stream (may be empty when the model only called the tool). */
  text: string
  finishReason: LLMFinishReason
}

export interface StreamSingleShotOptions {
  signal?: AbortSignal
  /** Stable id for the shared in-flight table. Generated when omitted. */
  inFlightId?: string
  /** Intent-level output cap from the generation harness. */
  maxTokens?: number
  temperature?: number
  /** Extra OpenAI-compatible body fields (reasoning, response_format). */
  samplingParams?: Record<string, unknown>
  /** Adapter-level payload patch for providers that ignore samplingParams (Gemini). */
  payloadPatch?: (payload: unknown) => unknown
  /** Optional callback for streaming text deltas in real-time. */
  onDelta?: (delta: string) => void
}

export class SingleShotAbortedError extends Error {
  readonly code = 'CANCELLED' as const

  constructor() {
    super('Single-shot generation was aborted.')
    this.name = 'SingleShotAbortedError'
  }
}

export class UnexpectedSubmitToolError extends Error {
  constructor(readonly toolName: string, readonly expected: string) {
    super(`Model called "${toolName}"; expected "${expected}".`)
    this.name = 'UnexpectedSubmitToolError'
  }
}

function asPiTool(tool: AnyAgentTool): Tool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SingleShotAbortedError()
}

export type SingleShotInput = string | ReadonlyArray<{ role: string; content: string }>

function toPiMessages(
  input: SingleShotInput,
  model: { api: Api; provider: ProviderId; id: string },
): { systemSuffix?: string; messages: Message[] } {
  if (typeof input === 'string') {
    return {
      messages: [{ role: 'user', content: input, timestamp: Date.now() }],
    }
  }

  const messages: Message[] = []
  const systemParts: string[] = []

  for (const msg of input) {
    if (msg.role === 'system') {
      systemParts.push(msg.content)
    } else if (msg.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: msg.content }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      })
    } else {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: msg.content }],
        timestamp: Date.now(),
      })
    }
  }

  if (messages.length === 0) {
    messages.push({ role: 'user', content: '', timestamp: Date.now() })
  }

  return {
    systemSuffix: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages,
  }
}

/**
 * One-shot pi-ai streaming call with a forced submit_* tool. The model must
 * emit its artifact as the tool's arguments; no read tools, no Agent loop.
 *
 * pi-ai does not validate tool names on the streaming path, so this layer
 * checks the expected submit_* name and runs `validateToolCall`.
 */
export async function streamSingleShot(
  profile: ModelProfile,
  systemPrompt: string,
  input: SingleShotInput,
  submitTool: AnyAgentTool,
  options: StreamSingleShotOptions = {},
): Promise<SingleShotResult> {
  throwIfAborted(options.signal)
  const releaseSlot = acquirePiOneShotSlot()
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  let unregister = () => {}

  try {
    throwIfAborted(options.signal)
    const { models, model } = createPiModels(profile)
    const tools = [asPiTool(submitTool)]
    options.signal?.addEventListener('abort', onOuterAbort, { once: true })
    unregister = registerPiInFlight(options.inFlightId ?? `single-shot:${randomUUID()}`, controller)
    const { systemSuffix, messages } = toPiMessages(input, model)
    const effectiveSystemPrompt = systemSuffix
      ? (systemPrompt ? `${systemPrompt}\n\n${systemSuffix}` : systemSuffix)
      : systemPrompt

    const stream = models.stream(model, {
      systemPrompt: effectiveSystemPrompt,
      messages,
      tools,
    }, {
      toolChoice: 'any',
      signal: controller.signal,
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.samplingParams ? { samplingParams: options.samplingParams } : {}),
      ...(options.payloadPatch
        ? { onPayload: (payload: unknown) => options.payloadPatch?.(payload) }
        : {}),
    })

    let text = ''
    let artifact: Record<string, unknown> | undefined
    let finishReason: LLMFinishReason = 'stop'
    for await (const event of stream) {
      throwIfAborted(options.signal)
      if (event.type === 'text_delta') {
        text += event.delta
        options.onDelta?.(event.delta)
      }
      if (event.type === 'toolcall_end') {
        if (event.toolCall.name !== submitTool.name) {
          throw new UnexpectedSubmitToolError(event.toolCall.name, submitTool.name)
        }
        artifact = validateToolCall(tools, event.toolCall) as Record<string, unknown>
      }
      if (event.type === 'done') {
        finishReason = event.reason === 'length' ? 'length' : 'stop'
      }
      if (event.type === 'error') {
        if (event.reason === 'aborted' || controller.signal.aborted) {
          throw new SingleShotAbortedError()
        }
        const assistantMsg: AssistantMessage = {
          role: 'assistant',
          content: [{ type: 'text', text: '' }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'error',
          errorMessage: event.error.errorMessage,
          timestamp: Date.now(),
        }
        if (isContextOverflow(assistantMsg, model.contextWindow)) {
          throw new Error(`Context overflow: ${event.error.errorMessage || 'Input exceeded model context window.'}`)
        }
        throw new Error(event.error.errorMessage || 'Single-shot generation failed.')
      }
    }
    throwIfAborted(options.signal)

    // 当模型因适配器或端点差异以纯文本形式输出 JSON，而未触发 toolcall_end 时，
    // 使用 Pi 原生 parseJsonWithRepair 与 validateToolCall 尝试修复解析并进行 TypeBox 架构校验
    if (!artifact && text.trim()) {
      try {
        const trimmed = text.trim()
        const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed)
        const cleanJson = fenced ? fenced[1].trim() : trimmed
        if (cleanJson.startsWith('{') || cleanJson.startsWith('[')) {
          const parsed = parseJsonWithRepair(cleanJson)
          if (parsed && typeof parsed === 'object') {
            artifact = validateToolCall(tools, {
              type: 'toolCall',
              id: 'fallback-submit',
              name: submitTool.name,
              arguments: parsed,
            }) as Record<string, unknown>
          }
        }
      } catch {
        // 回退解析校验失败时不中断，artifact 保持 undefined
      }
    }

    return { artifact, text, finishReason }
  } catch (error) {
    if (error instanceof SingleShotAbortedError) throw error
    if (controller.signal.aborted || options.signal?.aborted) {
      throw new SingleShotAbortedError()
    }
    throw error
  } finally {
    unregister()
    releaseSlot()
    options.signal?.removeEventListener('abort', onOuterAbort)
  }
}
