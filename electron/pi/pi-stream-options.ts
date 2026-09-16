import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from '@earendil-works/pi-ai'

import type { ResolvedGenerationParameters } from '../llm/generation-parameter-policy'

/**
 * 委托 @earendil-works/pi-ai 原生 clampThinkingLevel 对思考等级进行安全收敛。
 */
export function clampModelThinkingLevel<TApi extends Api = Api>(
  model: Model<TApi>,
  level: ModelThinkingLevel,
): ModelThinkingLevel {
  return clampThinkingLevel(model, level)
}

export { getSupportedThinkingLevels }

/**
 * Map product generation parameters onto pi-ai `StreamOptions.samplingParams`.
 *
 * Only the OpenAI-compatible adapters merge `samplingParams` into the request
 * body (last, so they override the named fields); the Google adapter never
 * reads them — see `patchGoogleSamplingPayload` for that side.
 */
export function toPiSamplingParams(
  params: ResolvedGenerationParameters,
): Record<string, unknown> | undefined {
  const sampling: Record<string, unknown> = {}
  if (params.responseFormat) sampling.response_format = params.responseFormat
  if (params.reasoning?.adapter === 'openai-reasoning-effort') {
    sampling.reasoning_effort = params.reasoning.reasoningEffort
  } else if (params.reasoning?.adapter === 'deepseek-v4-thinking') {
    sampling.thinking = { type: params.reasoning.thinking }
    if (params.reasoning.thinking === 'enabled') {
      sampling.reasoning_effort = params.reasoning.reasoningEffort
    }
  } else if (params.reasoning?.adapter === 'gemini-thinking-budget') {
    sampling.thinkingConfig = { thinkingBudget: params.reasoning.thinkingBudget }
  }
  return Object.keys(sampling).length > 0 ? sampling : undefined
}

/**
 * Model-level default sampling parameters for one pi-ai `Model`.
 *
 * The harness owns the request options it hands to providers and exposes no
 * temperature field, so the assistant track carries the resolved parameters
 * on the model itself. `temperature` rides inside `samplingParams` because the
 * OpenAI-compatible adapters merge those keys after the named request fields.
 */
export function toPiModelSamplingParams(
  params: ResolvedGenerationParameters,
): Record<string, unknown> | undefined {
  const sampling = { ...toPiSamplingParams(params) }
  if (params.temperature !== undefined) sampling.temperature = params.temperature
  return Object.keys(sampling).length > 0 ? sampling : undefined
}

/**
 * Whether the upstream behind this model id rejects `thinkingLevel: MINIMAL`.
 *
 * Google's GenAI API rejects `MINIMAL` ("Thinking level MINIMAL is not supported").
 * All Gemini models normalize `MINIMAL` to `LOW` globally without regex sniffing.
 */
export function rejectsMinimalThinkingLevel(..._args: unknown[]): boolean {
  void _args
  return true
}

export interface GooglePayloadPatchOptions {
  /**
   * 是否允许用产品侧解析出的思考预算改写 `thinkingConfig`。
   *
   * 助手会话里用户显式选了思考等级时传 false：那个等级由 harness 直接下发给
   * 适配器，再被预算覆盖会让用户的选择失效。
   */
  applyThinking?: boolean
}

/**
 * Apply the resolved parameters to a Google adapter payload.
 *
 * pi-ai's Google adapter builds `{ model, contents, config }` and only honors
 * `StreamOptions.temperature`; `samplingParams` (and therefore the whole
 * Gemini reasoning directive) are dropped. The harness does not pass a
 * temperature either, so both tracks patch the payload through `onPayload`.
 * Anything without a `config` object (every other adapter) is returned as is.
 */
export function patchGoogleSamplingPayload(
  payload: unknown,
  params: ResolvedGenerationParameters,
  options: GooglePayloadPatchOptions = {},
): unknown {
  if (!payload || typeof payload !== 'object') return payload
  const request = payload as { model?: unknown; config?: unknown }
  if (!request.config || typeof request.config !== 'object') return payload
  const config = request.config as Record<string, unknown>
  if (params.temperature !== undefined) config.temperature = params.temperature
  const reasoning = params.reasoning
  if (
    options.applyThinking !== false
    && reasoning?.adapter === 'gemini-thinking-budget'
    && reasoning.thinkingBudget > 0
  ) {
    config.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: reasoning.thinkingBudget,
    }
  }
  repairMinimalThinkingLevel(config)
  return payload
}

/**
 * 把 Google API 已废弃且上游报错的 MINIMAL 安全降级为 LOW。
 *
 * 彻底移除基于版本号的正则嗅探：只要 payload 携带了上游不接受的 MINIMAL，
 * 统一全局安全降级为 LOW。用户显式选取的等级（LOW/MEDIUM/HIGH）或预算不受影响。
 */
function repairMinimalThinkingLevel(config: Record<string, unknown>): void {
  const thinking = config.thinkingConfig
  if (!thinking || typeof thinking !== 'object') return
  const record = thinking as { thinkingLevel?: unknown }
  if (record.thinkingLevel !== 'MINIMAL') return
  config.thinkingConfig = { ...record, thinkingLevel: 'LOW' }
}
