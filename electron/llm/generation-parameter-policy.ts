import type { LLMRequest, ModelProfile } from '../../src/shared/ipc-channels'
import { resolveReasoningPolicy } from '../../src/shared/reasoning-policy'
import type {
  CreativeStrategy,
  GenerationReasoningStage,
  ProviderReasoningDirective,
} from '../../src/shared/reasoning-types'
import { resolvePiAiModelCapabilities } from '../services/model-execution-lease'

export interface ResolvedGenerationParameters {
  /** `undefined` means the provider must omit this request field. */
  temperature: number | undefined
  maxTokens: number
  responseFormat?: { type: 'json_object' | 'text' }
  reasoning?: ProviderReasoningDirective
}

type GenerationParameterRequest = Pick<LLMRequest, 'maxTokens' | 'responseFormat'> & {
  creativeStrategy?: CreativeStrategy
  reasoningStage?: GenerationReasoningStage
}

function hasModelFamilyPrefix(modelName: string, prefixes: readonly string[]): boolean {
  const normalized = modelName.trim().toLowerCase()
  return prefixes.some(prefix => normalized === prefix || normalized.startsWith(`${prefix}-`))
}

function validateKimiTemperature(temperature: number): void {
  if (Number.isFinite(temperature) && temperature >= 0 && temperature <= 1) return
  throw new Error('Kimi API 的 temperature 必须在 0 到 1 之间。请在模型设置中调整后重试。')
}

function isKimiReasoningModel(model: ModelProfile): boolean {
  // 1. Check Pi-AI official model registry
  const piModel = resolvePiAiModelCapabilities(model.modelName, model.provider)
  if (piModel?.reasoning) return true

  // 2. Check explicitly declared capability
  if (model.capabilities?.reasoning === true) return true

  // 3. Fallback: match Kimi reasoning model naming conventions (kimi-k2.5+, kimi-k3+, kimi-k4..., or *-thinking)
  const normalized = model.modelName.trim().toLowerCase()
  if (/^kimi-k(?:[2-9]|\d{2,})(?:\.\d+)?/i.test(normalized)) return true
  if (normalized.includes('thinking')) return true

  return false
}

/**
 * Resolves the effective provider request parameters from one model profile.
 * Model-profile temperature is the only user-visible sampling input; callers
 * may select workflow features and output budget but cannot override it.
 */
export function resolveGenerationParameters(
  model: ModelProfile,
  request: GenerationParameterRequest,
): ResolvedGenerationParameters {
  const isKimiModel = (model.provider as string) === 'moonshot'
    || hasModelFamilyPrefix(model.modelName, ['kimi', 'moonshot'])
  const usesFixedKimiTemperature = isKimiModel && isKimiReasoningModel(model)

  if (isKimiModel && !usesFixedKimiTemperature && model.temperature !== undefined) {
    validateKimiTemperature(model.temperature)
  }

  const reasoningResolution = resolveReasoningPolicy({
    model,
    creativeStrategy: request.creativeStrategy,
    stage: request.reasoningStage,
  })

  return {
    temperature: usesFixedKimiTemperature ? undefined : model.temperature,
    maxTokens: request.maxTokens ?? model.maxTokens,
    ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
    ...(reasoningResolution.providerDirective
      ? { reasoning: reasoningResolution.providerDirective }
      : {}),
  }
}
