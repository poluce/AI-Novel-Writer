import { describe, expect, it } from 'vitest'

import { createPiModels, resolveGeminiBaseUrl } from '../pi-models'

import type { ModelProfile } from '../../../src/shared/ipc-channels'

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'model-1',
    name: 'Test Model',
    provider: 'gemini',
    protocol: 'gemini',
    modelName: 'gemini-2.5-flash-lite',
    apiKey: 'test-key',
    baseUrl: 'https://proxy.example.com/antigravity',
    temperature: 0.7,
    maxTokens: 65_536,
    purposes: ['generation'],
    ...overrides,
  }
}

describe('resolveGeminiBaseUrl', () => {
  it('appends v1beta for an antigravity-style custom root', () => {
    expect(resolveGeminiBaseUrl('https://proxy.example.com/antigravity')).toBe(
      'https://proxy.example.com/antigravity/v1beta',
    )
  })
})

describe('createPiModels', () => {
  it('maps a gemini profile to the google-generative-ai API with a /v1beta base URL', () => {
    const { model, models } = createPiModels(profile())

    expect(model.api).toBe('google-generative-ai')
    expect(model.baseUrl).toBe('https://proxy.example.com/antigravity/v1beta')
    expect(model.provider).toBe('gemini')
    expect(models.getModel('gemini', 'gemini-2.5-flash-lite')?.api).toBe('google-generative-ai')
  })

  it('maps an openai profile to openai-completions with a passthrough base URL', () => {
    const { model } = createPiModels(profile({
      provider: 'openai',
      protocol: 'openai',
      modelName: 'gpt-4o',
      baseUrl: 'https://api.openai.com',
    }))

    expect(model.api).toBe('openai-completions')
    expect(model.baseUrl).toBe('https://api.openai.com')
    expect(model.provider).toBe('openai')
  })

  it('strips a trailing slash before appending /v1beta for gemini', () => {
    const { model } = createPiModels(profile({ baseUrl: 'https://proxy.example.com/antigravity/' }))

    expect(model.baseUrl).toBe('https://proxy.example.com/antigravity/v1beta')
  })

  it('does not double-append /v1beta when the custom base already includes a version path', () => {
    const { model } = createPiModels(profile({
      baseUrl: 'https://proxy.example.com/antigravity/v1beta',
    }))
    expect(model.baseUrl).toBe('https://proxy.example.com/antigravity/v1beta')
  })

  it('keeps vendor model ids that include a thinking suffix', () => {
    const { model } = createPiModels(profile({ modelName: 'gemini-3.1-pro-low' }))
    expect(model.id).toBe('gemini-3.1-pro-low')
  })

  it('does not rewrite the user-configured Gemini maxOutputTokens', () => {
    const { model } = createPiModels(profile({
      maxTokens: 65_536,
      capabilities: {
        contextWindowTokens: 1_048_576,
        maxOutputTokens: 65_536,
        reasoning: true,
        structuredOutput: true,
        usage: true,
      },
    }))
    expect(model.maxTokens).toBe(65_536)
  })

  it('derives context window and max tokens from verified capabilities when present', () => {
    const { model } = createPiModels(profile({
      capabilities: {
        contextWindowTokens: 200_000,
        maxOutputTokens: 8_000,
        reasoning: true,
        structuredOutput: true,
        usage: true,
        toolCalling: true,
      },
    }))

    expect(model.contextWindow).toBe(200_000)
    expect(model.maxTokens).toBe(8_000)
    expect(model.reasoning).toBe(true)
  })

  it('rejects a generation model that declared no tool calling', () => {
    expect(() => createPiModels(profile({
      capabilities: {
        contextWindowTokens: 8192,
        maxOutputTokens: 1024,
        reasoning: false,
        structuredOutput: false,
        usage: true,
        toolCalling: false,
      },
    }))).toThrow(/原生工具调用/)
  })

  it('carries product sampling parameters on the model for the harness track', () => {
    const { model } = createPiModels(profile(), {
      modelSamplingParams: { temperature: 0.4, reasoning_effort: 'medium' },
    })

    expect(model.samplingParams).toEqual({ temperature: 0.4, reasoning_effort: 'medium' })
  })

  it('leaves the model sampling parameters unset without a product policy', () => {
    expect(createPiModels(profile()).model.samplingParams).toBeUndefined()
  })
})
