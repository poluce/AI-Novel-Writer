import type { ResolvedGenerationParameters } from '../llm/generation-parameter-policy'

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
): unknown {
  if (!payload || typeof payload !== 'object') return payload
  const request = payload as { config?: unknown }
  if (!request.config || typeof request.config !== 'object') return payload
  const config = request.config as Record<string, unknown>
  if (params.temperature !== undefined) config.temperature = params.temperature
  const reasoning = params.reasoning
  if (reasoning?.adapter === 'gemini-thinking-budget' && reasoning.thinkingBudget > 0) {
    config.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: reasoning.thinkingBudget,
    }
  }
  return payload
}
