import { calculateContextTokens } from '@earendil-works/pi-agent-core'
import type { Usage } from '@earendil-works/pi-ai'

import { LLMHistoryRepository } from '../repositories/llm-repository'

/** `llm_calls` 记账用的模型身份。 */
export interface AgentCallIdentity {
  modelId: string
  modelName: string
}

interface AgentCallRecord extends AgentCallIdentity {
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
      totalTokens: record.usage ? calculateContextTokens(record.usage) : null,
      durationMs: Math.max(0, Date.now() - startedAt),
      success,
      errorMessage: record.errorMessage,
    })
  } catch (error) {
    console.warn('[AI Novel Writer] Agent LLM call statistics were not recorded.', error)
  }
}

/**
 * 记一次成功的模型请求。
 *
 * harness 每完成一次请求（含压缩、结构化摘要这类嵌套请求）都会发一条
 * `usage` 事件，事件里带着这次请求的用量，因此不再需要包 streamFn。
 */
export function recordAgentCall(
  identity: AgentCallIdentity,
  usage: Usage | undefined,
  startedAt: number,
  success: boolean,
): void {
  logAgentCall({ ...identity, usage }, startedAt, success)
}

/** 记一次失败的模型请求：harness 的 `run_end(status: 'failed' | 'aborted')`。 */
export function recordAgentFailure(identity: AgentCallIdentity, errorMessage: string): void {
  logAgentCall({ ...identity, usage: undefined, errorMessage }, Date.now(), false)
}
