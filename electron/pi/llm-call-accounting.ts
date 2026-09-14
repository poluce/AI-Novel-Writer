import type { StreamFn } from '@earendil-works/pi-agent-core'
import type { AssistantMessageEvent, Models, Usage } from '@earendil-works/pi-ai'

import { LLMHistoryRepository } from '../repositories/llm-repository'

interface AgentCallRecord {
  modelId: string
  modelName: string
  usage: Usage | undefined
  errorMessage?: string
}

function logAgentCall(record: AgentCallRecord, startedAt: number, success: boolean): void {
  try {
    LLMHistoryRepository.logCall({
      modelId: record.modelId,
      modelName: record.modelName,
      purpose: 'agent',
      promptTokens: record.usage?.input ?? null,
      completionTokens: record.usage?.output ?? null,
      totalTokens: record.usage?.totalTokens ?? null,
      durationMs: Math.max(0, Date.now() - startedAt),
      success,
      errorMessage: record.errorMessage,
    })
  } catch (error) {
    console.warn('[AI Novel Writer] Agent LLM call statistics were not recorded.', error)
  }
}

function recordStreamCall(
  modelId: string,
  modelName: string,
  startedAt: number,
  event: Extract<AssistantMessageEvent, { type: 'done' } | { type: 'error' }>,
): void {
  const message = event.type === 'done' ? event.message : event.error
  logAgentCall({
    modelId,
    modelName,
    usage: message.usage,
    errorMessage: event.type === 'error'
      ? (message.errorMessage || event.reason)
      : (event.reason === 'stop' || event.reason === 'toolUse'
        ? undefined
        : `finish:${event.reason}`),
  }, startedAt, event.type === 'done')
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
            recordStreamCall(model.id, model.name, startedAt, event)
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

/**
 * 让 Pi 的上下文压缩也记账。
 *
 * `compact()` 自己调 `models.completeSimple()` 生成摘要，不走 Agent 的 streamFn，
 * 不包一层就会白掉一条 `llm_calls`。其余方法原样透传。
 */
export function withCompactionCallAccounting(models: Models): Models {
  return new Proxy(models, {
    get(target, property, receiver) {
      if (property !== 'completeSimple') return Reflect.get(target, property, receiver)
      return async (...args: Parameters<Models['completeSimple']>) => {
        const startedAt = Date.now()
        const [model] = args
        try {
          const message = await target.completeSimple(...args)
          logAgentCall({
            modelId: model.id,
            modelName: model.name,
            usage: message.usage,
          }, startedAt, true)
          return message
        } catch (error) {
          logAgentCall({
            modelId: model.id,
            modelName: model.name,
            usage: undefined,
            errorMessage: error instanceof Error ? error.message : String(error),
          }, startedAt, false)
          throw error
        }
      }
    },
  })
}
