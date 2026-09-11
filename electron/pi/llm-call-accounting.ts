import type { StreamFn } from '@earendil-works/pi-agent-core'
import type { AssistantMessageEvent } from '@earendil-works/pi-ai'

import { LLMHistoryRepository } from '../repositories/llm-repository'

function recordAgentCall(
  modelId: string,
  modelName: string,
  startedAt: number,
  event: Extract<AssistantMessageEvent, { type: 'done' } | { type: 'error' }>,
): void {
  const message = event.type === 'done' ? event.message : event.error
  const usage = message.usage
  try {
    LLMHistoryRepository.logCall({
      modelId,
      modelName,
      purpose: 'agent',
      promptTokens: usage?.input ?? null,
      completionTokens: usage?.output ?? null,
      totalTokens: usage?.totalTokens ?? null,
      durationMs: Math.max(0, Date.now() - startedAt),
      success: event.type === 'done',
      errorMessage: event.type === 'error'
        ? (message.errorMessage || event.reason)
        : (event.reason === 'stop' || event.reason === 'toolUse'
          ? undefined
          : `finish:${event.reason}`),
    })
  } catch (error) {
    console.warn('[AI Novel Writer] Agent LLM call statistics were not recorded.', error)
  }
}

/**
 * Wrap a pi-ai streamFn so every inner LLM request writes one `llm_calls` row,
 * matching one-shot generation accounting.
 */
export function withLlmCallAccounting(streamFn: StreamFn): StreamFn {
  return async (model, context, options) => {
    const startedAt = Date.now()
    const stream = await streamFn(model, context, options)
    const original = stream[Symbol.asyncIterator].bind(stream)
    stream[Symbol.asyncIterator] = function () {
      const iterator = original()
      return {
        async next() {
          const result = await iterator.next()
          const event = result.value
          if (event && (event.type === 'done' || event.type === 'error')) {
            recordAgentCall(model.id, model.name, startedAt, event)
          }
          return result
        },
        return: iterator.return?.bind(iterator),
        throw: iterator.throw?.bind(iterator),
      }
    }
    return stream
  }
}
