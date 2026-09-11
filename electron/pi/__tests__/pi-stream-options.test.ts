import { describe, expect, it } from 'vitest'

import { toPiSamplingParams } from '../pi-stream-options'

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
