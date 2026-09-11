import type { ResolvedGenerationParameters } from '../llm/generation-parameter-policy'

/**
 * Map product generation parameters onto pi-ai StreamOptions.samplingParams.
 * OpenAI-compatible adapters merge these into the request body; Gemini ignores
 * unknown keys.
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
