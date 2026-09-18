import { describe, expect, it, vi } from 'vitest'

import type { ModelProfile } from '../../../shared/ipc-channels'
import {
  createGenerationRuntime,
  GenerationRuntimeError,
  type GenerationRuntimeEnvironment,
} from '../generation-runtime'
import { PromptBudgetExceededError } from '../generation-harness'

function testModel(id = 'model-a'): ModelProfile {
  return {
    id,
    name: id,
    provider: 'custom',
    protocol: 'openai',
    modelName: `${id}-v1`,
    baseUrl: 'https://example.invalid',
    apiKey: '',
    maxTokens: 4096,
  } as ModelProfile
}

function task(purpose: string) {
  return {
    purpose,
    output: 'visible-text' as const,
    messages: [{ role: 'user' as const, content: 'write' }],
  }
}

function budget() {
  return {
    maxAttempts: 1,
    maxRequestedOutputTokens: 4096,
    maxRequestedOutputTokensPerAttempt: 4096,
    deadlineMs: 60_000,
  }
}

describe('GenerationRuntime', () => {
  it('uses an explicitly selected model id without reading the mutable default', async () => {
    const snapshotDefaultModelId = vi.fn(() => 'model-a')
    const complete = vi.fn<GenerationRuntimeEnvironment['complete']>()
      .mockResolvedValue({ content: 'selected', finishReason: 'stop' })
    const environment: GenerationRuntimeEnvironment = {
      snapshotDefaultModelId,
      snapshotModel: (modelId) => testModel(modelId),
      complete,
    }
    const runtime = await createGenerationRuntime({
      modelId: 'model-b',
      budget: budget(),
    }, environment)

    const content = await runtime.execute(async ({ session }) => (
      (await session.complete(task('explicit-model'))).content
    ))

    expect(content).toBe('selected')
    expect(snapshotDefaultModelId).not.toHaveBeenCalled()
    expect(complete).toHaveBeenCalledOnce()
    expect(complete.mock.calls[0]?.[0].modelId).toBe('model-b')
  })

  it('rejects an oversized protected request before the provider is called', async () => {
    const complete = vi.fn<GenerationRuntimeEnvironment['complete']>()
    const environment: GenerationRuntimeEnvironment = {
      snapshotDefaultModelId: () => 'model-a',
      snapshotModel: (modelId) => testModel(modelId),
      complete,
    }
    const runtime = await createGenerationRuntime({ budget: budget() }, environment)
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    await expect(runtime.execute(async ({ session }) => (
      session.complete({
        purpose: 'protected',
        output: 'structured-data',
        messages: [{ role: 'user', content: 'x'.repeat(200_000) }],
        promptBudget: { limitUtf8Bytes: 16, sections: [] },
      })
    ))).rejects.toBeInstanceOf(PromptBudgetExceededError)
    expect(complete).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('looks up the current default model when none is specified', async () => {
    const complete = vi.fn<GenerationRuntimeEnvironment['complete']>()
      .mockResolvedValue({ content: 'defaulted', finishReason: 'stop' })
    const environment: GenerationRuntimeEnvironment = {
      snapshotDefaultModelId: () => 'model-a',
      snapshotModel: (modelId) => testModel(modelId),
      complete,
    }
    const runtime = await createGenerationRuntime({ budget: budget() }, environment)
    await runtime.execute(async ({ session }) => session.complete(task('default-model')))
    expect(complete.mock.calls[0]?.[0].modelId).toBe('model-a')
  })

  it('fails when no default model is configured', async () => {
    const environment: GenerationRuntimeEnvironment = {
      snapshotDefaultModelId: () => null,
      snapshotModel: () => null,
      complete: vi.fn(),
    }
    const runtime = await createGenerationRuntime({ budget: budget() }, environment)
    await expect(runtime.execute(async ({ session }) => session.complete(task('none'))))
      .rejects.toMatchObject({ code: 'NO_DEFAULT_MODEL' })
  })

  it('rejects a blank explicit model id', async () => {
    await expect(createGenerationRuntime({
      modelId: '   ',
      budget: budget(),
    })).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })
  })

  it('does not execute after the runtime is closed', async () => {
    const environment: GenerationRuntimeEnvironment = {
      snapshotDefaultModelId: () => 'model-a',
      snapshotModel: (modelId) => testModel(modelId),
      complete: vi.fn(),
    }
    const runtime = await createGenerationRuntime({ budget: budget() }, environment)
    await runtime.close()
    await expect(runtime.execute(async ({ session }) => session.complete(task('closed'))))
      .rejects.toBeInstanceOf(GenerationRuntimeError)
  })
})
