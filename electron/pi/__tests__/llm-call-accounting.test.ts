import { beforeEach, describe, expect, it, vi } from 'vitest'

const logCall = vi.fn()

vi.mock('../../repositories/llm-repository', () => ({
  LLMHistoryRepository: { logCall: (...args: unknown[]) => logCall(...args) },
}))

import { recordAgentCall, recordAgentFailure } from '../llm-call-accounting'

const identity = { modelId: 'm1', modelName: 'gemini-2.5-pro' }

beforeEach(() => {
  logCall.mockClear()
})

describe('recordAgentCall', () => {
  it('writes one llm_calls row with the request usage', () => {
    recordAgentCall(identity, {
      input: 120,
      output: 40,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 160,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }, Date.now() - 25, true)

    expect(logCall).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'agent',
      success: true,
      modelId: 'm1',
      modelName: 'gemini-2.5-pro',
      promptTokens: 120,
      completionTokens: 40,
      totalTokens: 160,
    }))
    const record = logCall.mock.calls[0][0] as { durationMs: number }
    expect(record.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('calculates total tokens via Pi calculateContextTokens when totalTokens is omitted or 0', () => {
    recordAgentCall(identity, {
      input: 300,
      output: 100,
      cacheRead: 50,
      cacheWrite: 20,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }, Date.now() - 10, true)

    expect(logCall).toHaveBeenCalledWith(expect.objectContaining({
      promptTokens: 300,
      completionTokens: 100,
      totalTokens: 470,
    }))
  })

  it('keeps null token columns when the provider reported no usage', () => {
    recordAgentCall(identity, undefined, Date.now(), true)

    expect(logCall).toHaveBeenCalledWith(expect.objectContaining({
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    }))
  })

  it('never lets a failing accounting write break the run', () => {
    logCall.mockImplementationOnce(() => {
      throw new Error('database is closed')
    })

    expect(() => recordAgentCall(identity, undefined, Date.now(), true)).not.toThrow()
  })
})

describe('recordAgentFailure', () => {
  it('records the harness run failure', () => {
    recordAgentFailure(identity, 'provider exploded')

    expect(logCall).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'agent',
      success: false,
      errorMessage: 'provider exploded',
      totalTokens: null,
    }))
  })
})
