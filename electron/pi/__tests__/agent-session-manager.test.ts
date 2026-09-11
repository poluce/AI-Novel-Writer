import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { abortPiInFlight, resetPiInFlightForTests } from '../in-flight'
import { AgentSessionManager } from '../agent-session-manager'

vi.mock('../agent-session', () => ({
  AgentSession: class {
    prompt = vi.fn(async () => {})
    confirm = vi.fn()
    abort = vi.fn()
  },
}))
vi.mock('../pi-models', () => ({
  createPiModels: vi.fn(() => ({ models: { streamSimple: vi.fn() }, model: {} })),
}))
vi.mock('../tool-builder', () => ({
  buildAgentTools: vi.fn(() => []),
  confirmationToolNames: vi.fn(() => new Set(['write_file'])),
}))

import { createPiModels } from '../pi-models'
import { buildAgentTools } from '../tool-builder'

const createPiModelsMock = createPiModels as ReturnType<typeof vi.fn>
const buildToolsMock = buildAgentTools as ReturnType<typeof vi.fn>

function buildManager() {
  const events: Array<{ conversationId: string; event: unknown }> = []
  const manager = new AgentSessionManager({
    resolveModel: () => ({ id: 'm1', name: 'M', provider: 'gemini', protocol: 'gemini', modelName: 'g', apiKey: 'k', baseUrl: 'https://x', temperature: 0.7, maxTokens: 100, purposes: ['generation'] }),
    resolveSystemPrompt: () => 'sys',
    resolveLanguage: () => 'zh-CN',
    emit: (conversationId, event) => events.push({ conversationId, event }),
    rendererAction: () => {},
  })
  return { manager, events }
}

beforeEach(() => {
  createPiModelsMock.mockClear()
  buildToolsMock.mockClear()
})

afterEach(() => {
  resetPiInFlightForTests()
})

describe('AgentSessionManager', () => {
  it('creates one session per conversation and reuses it', async () => {
    const { manager } = buildManager()
    await manager.prompt('conv-1', 'hi')
    await manager.prompt('conv-1', 'again')

    expect(createPiModelsMock).toHaveBeenCalledTimes(1)
    expect(buildToolsMock).toHaveBeenCalledTimes(1)
  })

  it('delegates confirm and abort to the session', async () => {
    const { manager } = buildManager()
    await manager.prompt('conv-1', 'hi')

    expect(manager.confirm('conv-1', 'call-1', true)).toEqual({ success: true })
    expect(manager.abort('conv-1')).toEqual({ success: true })
  })

  it('returns failure for an unknown conversation', () => {
    const { manager } = buildManager()
    expect(manager.confirm('missing', 'call-1', true)).toEqual({ success: false })
    expect(manager.abort('missing')).toEqual({ success: false })
  })

  it('registers the session on the shared in-flight table', async () => {
    const { manager } = buildManager()
    await manager.prompt('conv-1', 'hi')

    expect(abortPiInFlight('agent:conv-1')).toBe(true)
  })

  it('aborts every session from abortAll', async () => {
    const { manager } = buildManager()
    await manager.prompt('conv-1', 'hi')
    await manager.prompt('conv-2', 'hi')

    manager.abortAll()
    expect(manager.abort('conv-1')).toEqual({ success: true })
  })
})
