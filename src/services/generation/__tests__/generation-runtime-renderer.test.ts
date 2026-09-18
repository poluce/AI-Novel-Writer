import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectData } from '../../../shared/ipc-channels'
import type { CreativeStrategy } from '../../../shared/reasoning-types'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (data: never) => void>(),
}))

vi.mock('../../ipc-client', () => ({
  ipc: {
    invoke: mocks.invoke,
    on: vi.fn((channel: string, callback: (data: never) => void) => {
      mocks.listeners.set(channel, callback)
      return () => mocks.listeners.delete(channel)
    }),
    get isElectron() { return true },
  },
}))

vi.mock('../../../components/ui/AlertDialog', () => ({ alertError: vi.fn() }))

import { useLLMStore } from '../../../stores/llm-store'
import { useProjectStore } from '../../../stores/project-store'
import { createGenerationRuntime } from '../generation-runtime'

function project(id: string, creativeStrategy: CreativeStrategy): ProjectData {
  return {
    id,
    name: id,
    path: `C:/projects/${id}`,
    novelConfig: {
      creativeStrategy,
      genre: 'fantasy',
      subGenre: '',
      targetAudience: 'all',
      totalChapters: 10,
      wordsPerChapter: 3000,
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: '',
      worldSetting: '',
      goldenFinger: '',
      protagonistProfile: '',
      globalGuidance: '',
    },
    characterStates: '',
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
  }
}

describe('GenerationRuntime renderer adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listeners.clear()
    useLLMStore.setState({
      defaultModelId: 'model-a',
      models: [{
        id: 'model-a',
        name: 'Model A',
        provider: 'custom',
        protocol: 'openai',
        modelName: 'model-a-v1',
        baseUrl: 'https://example.invalid',
        apiKey: '',
        maxTokens: 4096,
      } as never],
      activeRequests: new Map(),
      loaded: true,
    })
    useProjectStore.setState({ currentProject: project('project-a', 'consistency-first') })
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'llm:generate-stream') {
        const requestId = String(args[0])
        queueMicrotask(() => {
          mocks.listeners.get('llm:stream-done')?.({
            requestId,
            fullText: 'completion',
            finishReason: 'stop',
          } as never)
        })
        return { requestId, started: true }
      }
      throw new Error(`unexpected channel: ${channel}`)
    })
  })

  it('forwards the current model id and project session on generate-stream', async () => {
    const runtime = await createGenerationRuntime({
      budget: {
        maxAttempts: 1,
        maxRequestedOutputTokens: 4096,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    })
    const content = await runtime.execute(async ({ session }) => (
      (await session.complete({
        purpose: 'draft',
        output: 'visible-text',
        messages: [{ role: 'user', content: 'write' }],
      })).content
    ))
    expect(content).toBe('completion')
    expect(mocks.invoke).toHaveBeenCalledWith(
      'llm:generate-stream',
      expect.any(String),
      expect.objectContaining({
        modelId: 'model-a',
        projectSession: expect.objectContaining({
          projectId: 'project-a',
          projectPath: 'C:/projects/project-a',
        }),
      }),
    )
    expect(mocks.invoke.mock.calls.map(([channel]) => channel)).not.toContain('llm:begin-execution-lease')
  })

  it('fails when the selected model is missing from the renderer catalog', async () => {
    useLLMStore.setState({ defaultModelId: 'deleted-model', models: [] })
    const runtime = await createGenerationRuntime({
      budget: {
        maxAttempts: 1,
        maxRequestedOutputTokens: 4096,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    })
    await expect(runtime.execute(async ({ session }) => session.complete({
      purpose: 'draft',
      output: 'visible-text',
      messages: [{ role: 'user', content: 'write' }],
    }))).rejects.toMatchObject({ message: expect.stringMatching(/模型/) })
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
