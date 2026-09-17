import { describe, expect, it } from 'vitest'

import { resolveReasoningPolicy } from '../reasoning-policy'
import type { ModelProfile } from '../ipc-channels'

const geminiFlashLite: ModelProfile = {
  id: 'gemini-flash-lite',
  name: 'Gemini 2.5 Flash Lite',
  provider: 'gemini',
  protocol: 'gemini',
  modelName: 'gemini-2.5-flash-lite',
  apiKey: 'test-key',
  baseUrl: 'https://generativelanguage.googleapis.com',
  temperature: 0.7,
  maxTokens: 65_536,
  purposes: ['generation'],
}

describe('reasoning policy', () => {
  it('uses the project strategy and generation purpose to request stage-specific effort', () => {
    expect(resolveReasoningPolicy({
      model: geminiFlashLite,
      creativeStrategy: 'fluent-drafting',
      stage: 'drafting',
    })).toMatchObject({
      requested: 'off',
      effective: 'off',
      status: 'mapped',
      providerDirective: { adapter: 'gemini-thinking-budget', thinkingBudget: 0 },
    })

    expect(resolveReasoningPolicy({
      model: geminiFlashLite,
      creativeStrategy: 'deep-planning',
      stage: 'planning',
    })).toMatchObject({
      requested: 'max',
      effective: 'high',
      status: 'capped',
      providerDirective: { adapter: 'gemini-thinking-budget', thinkingBudget: 24_576 },
    })
  })

  it('defines four distinct strategy profiles without making deep-planning drafts maximal', () => {
    const requestedProfile = (creativeStrategy: 'auto' | 'fluent-drafting' | 'consistency-first' | 'deep-planning') => (
      ['drafting', 'planning', 'review', 'general'] as const
    ).map(stage => resolveReasoningPolicy({
      model: { ...geminiFlashLite, provider: 'custom', baseUrl: 'https://example.test' },
      creativeStrategy,
      stage,
    }).requested)

    const profiles = {
      auto: requestedProfile('auto'),
      fluent: requestedProfile('fluent-drafting'),
      consistency: requestedProfile('consistency-first'),
      deep: requestedProfile('deep-planning'),
    }

    expect(new Set(Object.values(profiles).map(profile => profile.join('|'))).size).toBe(4)
    expect(profiles.auto).toEqual(['low', 'medium', 'high', 'low'])
    expect(profiles.deep).toEqual(['low', 'max', 'high', 'medium'])
    expect(profiles.consistency).not.toEqual(profiles.deep)
  })

  it('lets the model-profile override take precedence without changing the project strategy', () => {
    const model = { ...geminiFlashLite, reasoningOverride: 'high' as const }
    const projectStrategy = 'fluent-drafting' as const

    expect(resolveReasoningPolicy({
      model,
      creativeStrategy: projectStrategy,
      stage: 'drafting',
    })).toMatchObject({
      requested: 'high',
      effective: 'high',
      status: 'mapped',
      source: 'model-override',
    })
    expect(projectStrategy).toBe('fluent-drafting')
  })

  it('caps unavailable maximum effort and reports models whose reasoning cannot be disabled', () => {
    const grok: ModelProfile = {
      ...geminiFlashLite,
      id: 'grok-4.5',
      provider: 'xai',
      protocol: 'openai',
      modelName: 'grok-4.5',
      baseUrl: 'https://api.x.ai/v1',
      reasoningOverride: 'max',
    }
    expect(resolveReasoningPolicy({ model: grok, stage: 'review' })).toMatchObject({
      requested: 'max',
      effective: 'high',
      status: 'capped',
      providerDirective: { adapter: 'openai-reasoning-effort', reasoningEffort: 'high' },
    })

    expect(resolveReasoningPolicy({
      model: { ...grok, reasoningOverride: 'off' },
      creativeStrategy: 'fluent-drafting',
      stage: 'drafting',
    })).toMatchObject({ requested: 'off', effective: 'low', status: 'forced' })
  })

  it('suppresses reasoning fields for unknown custom endpoints and unverified built-in models', () => {
    const custom = {
      ...geminiFlashLite,
      provider: 'custom' as const,
      protocol: 'openai' as const,
      baseUrl: 'https://gemini-proxy.example.test/v1',
      modelName: 'gemini-2.5-flash-lite',
      reasoningOverride: 'high' as const,
    }
    expect(resolveReasoningPolicy({ model: custom, stage: 'planning' })).toEqual({
      requested: 'high',
      effective: null,
      status: 'unsupported',
      source: 'model-override',
    })

    const unverifiedDeepSeek = {
      ...geminiFlashLite,
      provider: 'deepseek' as const,
      protocol: 'openai' as const,
      baseUrl: 'https://api.deepseek.com',
      modelName: 'deepseek-future-model',
      reasoningOverride: 'high' as const,
    }
    expect(resolveReasoningPolicy({ model: unverifiedDeepSeek, stage: 'planning' }))
      .not.toHaveProperty('providerDirective')
  })

  it('maps the exact official DeepSeek V4 profile without trusting persisted capability flags', () => {
    const legacyDeepSeek: ModelProfile = {
      ...geminiFlashLite,
      provider: 'deepseek',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      modelName: 'deepseek-v4-flash',
      capabilities: {
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 384_000,
        reasoning: false,
        structuredOutput: true,
        usage: true,
      },
    }

    expect(resolveReasoningPolicy({
      model: legacyDeepSeek,
      creativeStrategy: 'fluent-drafting',
      stage: 'drafting',
    })).toMatchObject({
      requested: 'off',
      effective: 'off',
      status: 'mapped',
      providerDirective: { adapter: 'deepseek-v4-thinking', thinking: 'disabled' },
    })

    expect(resolveReasoningPolicy({
      model: legacyDeepSeek,
      creativeStrategy: 'auto',
      stage: 'drafting',
    })).toMatchObject({
      requested: 'low',
      effective: 'low',
      status: 'mapped',
      providerDirective: {
        adapter: 'deepseek-v4-thinking',
        thinking: 'enabled',
        reasoningEffort: 'low',
      },
    })

    expect(resolveReasoningPolicy({
      model: { ...legacyDeepSeek, reasoningOverride: 'medium' },
      stage: 'planning',
    })).toMatchObject({
      requested: 'medium',
      effective: 'high',
      status: 'mapped',
      providerDirective: {
        adapter: 'deepseek-v4-thinking',
        thinking: 'enabled',
        reasoningEffort: 'high',
      },
    })

    expect(resolveReasoningPolicy({
      model: { ...legacyDeepSeek, reasoningOverride: 'max' },
      stage: 'review',
    })).toMatchObject({
      requested: 'max',
      effective: 'max',
      status: 'mapped',
      providerDirective: {
        adapter: 'deepseek-v4-thinking',
        thinking: 'enabled',
        reasoningEffort: 'max',
      },
    })
  })

  it.each([
    ['siliconflow', 'https://api.siliconflow.cn/v1', 'deepseek-ai/DeepSeek-V3.2'],
    ['custom', 'https://qwen-proxy.example.test/v1', 'qwen-long'],
  ] as const)('does not inject official DeepSeek V4 fields for %s/%s/%s', (
    provider,
    baseUrl,
    modelName,
  ) => {
    expect(resolveReasoningPolicy({
      model: {
        ...geminiFlashLite,
        provider,
        protocol: 'openai',
        baseUrl,
        modelName,
        reasoningOverride: 'low',
      },
      stage: 'drafting',
    })).not.toHaveProperty('providerDirective')
  })

  it('normalizes stale persisted policy values instead of sending an unverified parameter', () => {
    const staleModel = {
      ...geminiFlashLite,
      reasoningOverride: 'ultra-from-old-build',
    } as unknown as ModelProfile

    expect(resolveReasoningPolicy({
      model: staleModel,
      creativeStrategy: 'obsolete-strategy' as never,
      stage: 'drafting',
    })).toMatchObject({
      requested: 'low',
      effective: 'low',
      status: 'mapped',
      source: 'project-strategy',
    })
  })

  it('maps reasoning for custom relay endpoints when model declares reasoning capability', () => {
    const relayGemini: ModelProfile = {
      ...geminiFlashLite,
      provider: 'gemini',
      protocol: 'gemini',
      modelName: 'gemini-3.8-flash',
      baseUrl: 'https://codelinklink.online/antigravity',
      capabilities: {
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 8192,
        reasoning: true,
        structuredOutput: true,
        usage: true,
      },
    }

    expect(resolveReasoningPolicy({ model: relayGemini, stage: 'drafting' })).toMatchObject({
      requested: 'low',
      effective: 'low',
      status: 'mapped',
      providerDirective: { adapter: 'gemini-thinking-budget', thinkingBudget: 1024 },
    })

    expect(resolveReasoningPolicy({ model: relayGemini, stage: 'planning' })).toMatchObject({
      requested: 'medium',
      effective: 'medium',
      status: 'mapped',
      providerDirective: { adapter: 'gemini-thinking-budget', thinkingBudget: 8192 },
    })

    expect(resolveReasoningPolicy({ model: relayGemini, stage: 'review' })).toMatchObject({
      requested: 'high',
      effective: 'high',
      status: 'mapped',
      providerDirective: { adapter: 'gemini-thinking-budget', thinkingBudget: 24576 },
    })
  })

  it('does not sniff regex or force openai reasoning effort for unknown OpenAI models on custom relay', () => {
    const customQwQ: ModelProfile = {
      ...geminiFlashLite,
      provider: 'custom',
      protocol: 'openai',
      modelName: 'qwq-32b-preview',
      baseUrl: 'https://my-relay.example.com/v1',
      capabilities: {
        contextWindowTokens: 131_072,
        maxOutputTokens: 8192,
        reasoning: true,
        structuredOutput: true,
        usage: true,
      },
    }

    // Without explicit adapter, unknown models do not inject proprietary OpenAI reasoning_effort
    const resolution = resolveReasoningPolicy({ model: customQwQ, stage: 'planning' })
    expect(resolution).toMatchObject({
      status: 'unsupported',
      effective: null,
    })
    expect(resolution.providerDirective).toBeUndefined()

    // With explicit reasoningAdapter configured by user, honors the user selection without regex sniffing
    const configuredDeepSeek: ModelProfile = {
      ...customQwQ,
      modelName: 'unusual-relay-model-slug',
      capabilities: {
        ...customQwQ.capabilities!,
        reasoningAdapter: 'deepseek-v4-thinking',
      },
    }
    const deepSeekRes = resolveReasoningPolicy({ model: configuredDeepSeek, stage: 'planning' })
    expect(deepSeekRes).toMatchObject({
      status: 'mapped',
      providerDirective: {
        adapter: 'deepseek-v4-thinking',
        thinking: 'enabled',
        reasoningEffort: 'high',
      },
    })
  })

  it('honors requested taskKey and explicit requestedEffort overrides', () => {
    const geminiThinking: ModelProfile = {
      id: 'gemini-model',
      name: 'Gemini 2.5 Flash',
      provider: 'gemini',
      protocol: 'gemini',
      modelName: 'gemini-2.5-flash',
      apiKey: 'k',
      baseUrl: 'https://gemini',
      temperature: 0.7,
      maxTokens: 8192,
      purposes: ['generation'],
      capabilities: {
        contextWindowTokens: 1_048_576,
        maxOutputTokens: 8192,
        reasoning: true,
        structuredOutput: true,
        usage: true,
      },
    }

    // taskKey: 'outline' defaults to 'high' effort (thinkingBudget 24576 on Gemini)
    const outlineRes = resolveReasoningPolicy({ model: geminiThinking, taskKey: 'outline' })
    expect(outlineRes).toMatchObject({
      requested: 'high',
      effective: 'high',
      status: 'mapped',
      providerDirective: {
        adapter: 'gemini-thinking-budget',
        thinkingBudget: 24_576,
      },
    })

    // explicit requestedEffort: 'low' uses low budget
    const lowRes = resolveReasoningPolicy({ model: geminiThinking, taskKey: 'outline', requestedEffort: 'low' })
    expect(lowRes).toMatchObject({
      requested: 'low',
      effective: 'low',
      status: 'mapped',
      providerDirective: {
        adapter: 'gemini-thinking-budget',
        thinkingBudget: 1_024,
      },
    })

    // explicit requestedEffort: 'off' disables thinking
    const offRes = resolveReasoningPolicy({ model: geminiThinking, taskKey: 'drafting', requestedEffort: 'off' })
    expect(offRes).toMatchObject({
      requested: 'off',
      effective: 'off',
      status: 'mapped',
      providerDirective: {
        adapter: 'gemini-thinking-budget',
        thinkingBudget: 0,
      },
    })
  })
})
