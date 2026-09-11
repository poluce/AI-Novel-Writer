import { describe, expect, it } from 'vitest'

import {
  TOOL_CALLING_REQUIRED_CODE,
  assertGenerationModelSupportsTools,
  generationModelLacksToolCalling,
} from '../tool-calling-gate'

describe('tool-calling generation gate', () => {
  it('rejects an explicit non-tool generation model', () => {
    const model = { capabilities: { toolCalling: false as const } }
    expect(generationModelLacksToolCalling(model)).toBe(true)
    expect(() => assertGenerationModelSupportsTools(model)).toThrow(/原生工具调用/)
    try {
      assertGenerationModelSupportsTools(model)
    } catch (error) {
      expect(error).toMatchObject({ code: TOOL_CALLING_REQUIRED_CODE })
    }
  })

  it('allows legacy generation models that have not declared toolCalling', () => {
    expect(generationModelLacksToolCalling({ purposes: ['generation'] })).toBe(false)
    expect(() => assertGenerationModelSupportsTools({ purposes: ['generation'] })).not.toThrow()
  })

  it('does not gate embedding-only models', () => {
    expect(generationModelLacksToolCalling({
      purposes: ['embedding'],
      capabilities: { toolCalling: false },
    })).toBe(false)
  })
})
