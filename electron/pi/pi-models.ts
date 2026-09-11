import {
  createModels,
  createProvider,
  type Model,
  type Models,
} from '@earendil-works/pi-ai'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

import type { ModelProfile } from '../../src/shared/ipc-channels'
import { assertGenerationModelSupportsTools } from '../../src/shared/tool-calling-gate'

/** Zeroed cost table — the app keeps its own `llm_calls` accounting. */
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

type PiChatModel = Model<'google-generative-ai'> | Model<'openai-completions'>

export interface PiModelRuntime {
  /** Provider collection holding exactly the one runtime model. */
  models: Models
  /** The pi-ai model object the app streams through. */
  model: PiChatModel
}

/**
 * Map one persisted `ModelProfile` to a pi-ai `Models` collection.
 *
 * P0 findings baked in:
 * - Gemini: the Google adapter clears `@google/genai` `apiVersion` whenever
 *   `model.baseUrl` is set, so the base URL must already end in `/v1beta`.
 * - OpenAI-compatible: straight passthrough of the profile base URL.
 *
 * The API key is supplied through the provider's `apiKey.resolve()` so the
 * renderer never touches it; the profile stays the sole key source.
 */
export function createPiModels(profile: ModelProfile): PiModelRuntime {
  assertGenerationModelSupportsTools(profile)
  const isGemini = profile.protocol === 'gemini'
  const baseUrl = isGemini
    ? `${profile.baseUrl.replace(/\/+$/, '')}/v1beta`
    : profile.baseUrl

  const model = (isGemini
    ? {
        api: 'google-generative-ai',
        baseUrl,
      }
    : {
        api: 'openai-completions',
        baseUrl,
      }) as {
    api: 'google-generative-ai' | 'openai-completions'
    baseUrl: string
  }

  const piModel: PiChatModel = {
    id: profile.modelName,
    name: profile.modelName,
    api: model.api,
    provider: profile.provider,
    baseUrl: model.baseUrl,
    reasoning: profile.capabilities?.reasoning ?? false,
    input: ['text'],
    cost: ZERO_COST,
    contextWindow: profile.capabilities?.contextWindowTokens ?? 1_000_000,
    maxTokens: profile.capabilities?.maxOutputTokens ?? profile.maxTokens,
  }

  const provider = createProvider({
    id: profile.provider,
    baseUrl,
    auth: {
      apiKey: {
        name: `${profile.provider} API key`,
        resolve: async () => ({ auth: { apiKey: profile.apiKey } }),
      },
    },
    models: [piModel],
    api: isGemini ? googleGenerativeAIApi() : openAICompletionsApi(),
  })

  const models = createModels()
  models.setProvider(provider)
  return { models, model: piModel }
}
