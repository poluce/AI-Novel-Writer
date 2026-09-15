import { describe, expect, it } from 'vitest'

import {
  patchGoogleSamplingPayload,
  toPiModelSamplingParams,
  toPiSamplingParams,
} from '../pi-stream-options'

describe('toPiSamplingParams', () => {
  it('maps OpenAI reasoning effort and JSON response format', () => {
    expect(toPiSamplingParams({
      temperature: 0.7,
      maxTokens: 512,
      responseFormat: { type: 'json_object' },
      reasoning: { adapter: 'openai-reasoning-effort', reasoningEffort: 'medium' },
    })).toEqual({
      response_format: { type: 'json_object' },
      reasoning_effort: 'medium',
    })
  })

  it('maps DeepSeek V4 thinking on and off', () => {
    expect(toPiSamplingParams({
      temperature: 0.7,
      maxTokens: 512,
      reasoning: { adapter: 'deepseek-v4-thinking', thinking: 'disabled' },
    })).toEqual({ thinking: { type: 'disabled' } })
    expect(toPiSamplingParams({
      temperature: 0.7,
      maxTokens: 512,
      reasoning: { adapter: 'deepseek-v4-thinking', thinking: 'enabled', reasoningEffort: 'low' },
    })).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'low' })
  })

  it('omits samplingParams when nothing extra is set', () => {
    expect(toPiSamplingParams({ temperature: 1, maxTokens: 256 })).toBeUndefined()
  })
})

describe('toPiModelSamplingParams', () => {
  it('carries the profile temperature so the harness track can apply it', () => {
    expect(toPiModelSamplingParams({
      temperature: 0.6,
      maxTokens: 512,
      reasoning: { adapter: 'openai-reasoning-effort', reasoningEffort: 'high' },
    })).toEqual({ reasoning_effort: 'high', temperature: 0.6 })
  })

  it('omits a temperature the provider must not receive', () => {
    expect(toPiModelSamplingParams({
      temperature: undefined,
      maxTokens: 512,
      reasoning: { adapter: 'deepseek-v4-thinking', thinking: 'enabled', reasoningEffort: 'low' },
    })).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'low' })
  })

  it('returns nothing when the model has no product parameters', () => {
    expect(toPiModelSamplingParams({ temperature: undefined, maxTokens: 256 })).toBeUndefined()
  })
})

describe('patchGoogleSamplingPayload', () => {
  it('writes temperature and an enabled thinking budget into the Google config', () => {
    const payload = {
      model: 'gemini-2.5-flash-lite',
      contents: [],
      config: { maxOutputTokens: 4096 },
    }
    const patched = patchGoogleSamplingPayload(payload, {
      temperature: 0.4,
      maxTokens: 4096,
      reasoning: { adapter: 'gemini-thinking-budget', thinkingBudget: 8192 },
    })

    expect(patched).toBe(payload)
    expect(payload.config).toEqual({
      maxOutputTokens: 4096,
      temperature: 0.4,
      thinkingConfig: { includeThoughts: true, thinkingBudget: 8192 },
    })
  })

  it('leaves thinking alone when the policy turns it off', () => {
    const payload = { model: 'gemini-2.5-flash-lite', contents: [], config: {} }
    patchGoogleSamplingPayload(payload, {
      temperature: undefined,
      maxTokens: 4096,
      reasoning: { adapter: 'gemini-thinking-budget', thinkingBudget: 0 },
    })
    expect(payload.config).toEqual({})
  })

  it('passes anything that is not a Google payload straight through', () => {
    const payload = { model: 'deepseek-chat', messages: [] }
    expect(patchGoogleSamplingPayload(payload, { temperature: 0.4, maxTokens: 512 })).toBe(payload)
    expect(patchGoogleSamplingPayload(undefined, { temperature: 0.4, maxTokens: 512 })).toBeUndefined()
  })
})
