import { describe, expect, it } from 'vitest'

import { createPiModels } from '../pi-models'

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
})
