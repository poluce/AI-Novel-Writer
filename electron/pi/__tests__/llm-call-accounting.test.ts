import { describe, expect, it, vi } from 'vitest'

const logCall = vi.fn()

vi.mock('../../repositories/llm-repository', () => ({
  LLMHistoryRepository: { logCall: (...args: unknown[]) => logCall(...args) },
}))

import type { StreamFn } from '@earendil-works/pi-agent-core'
import { createModels } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'

import { withLlmCallAccounting } from '../llm-call-accounting'

describe('withLlmCallAccounting', () => {
  it('writes one llm_calls row when a stream finishes', async () => {
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    faux.setResponses([fauxAssistantMessage('hello')])

    const streamFn: StreamFn = models.streamSimple.bind(models)
    const accounted = withLlmCallAccounting(streamFn)
    const stream = await accounted(faux.getModel(), {
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }],
    })
    for await (const event of stream) void event

    expect(logCall).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'agent',
      success: true,
      modelName: expect.any(String),
    }))
  })
})
