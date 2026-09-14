import { randomUUID } from 'node:crypto'

import { validateToolCall, type Tool } from '@earendil-works/pi-ai'

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
  userPrompt: string,
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
    const stream = models.stream(model, {
      systemPrompt,
      messages: [{ role: 'user', content: userPrompt, timestamp: Date.now() }],
      tools,
    }, {
      toolChoice: 'any',
      signal: controller.signal,
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.samplingParams ? { samplingParams: options.samplingParams } : {}),
    })

    let text = ''
    let artifact: Record<string, unknown> | undefined
    let finishReason: LLMFinishReason = 'stop'
    for await (const event of stream) {
      throwIfAborted(options.signal)
      if (event.type === 'text_delta') text += event.delta
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
        throw new Error(event.error.errorMessage || 'Single-shot generation failed.')
      }
    }
    throwIfAborted(options.signal)
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
