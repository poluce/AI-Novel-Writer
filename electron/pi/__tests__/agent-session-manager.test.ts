import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { abortPiInFlight, resetPiInFlightForTests } from '../in-flight'
import { AgentSessionManager } from '../agent-session-manager'
import type { AgentConversationStore } from '../agent-conversation-store'

const h = vi.hoisted(() => ({ sessions: [] as Array<Record<string, ReturnType<typeof vi.fn>>> }))

vi.mock('../agent-session', () => ({
  AgentSession: class {
    prompt = vi.fn(async () => {})
    setEditorSnapshot = vi.fn()
    setTools = vi.fn()
    setSystemPrompt = vi.fn()
    confirm = vi.fn()
    abort = vi.fn()
    restoreSnapshot = vi.fn(() => true)
    restoreHistory = vi.fn()
    constructor() {
      h.sessions.push(this as unknown as Record<string, ReturnType<typeof vi.fn>>)
    }
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

function buildManager(store: AgentConversationStore | null = null) {
  const events: Array<{ conversationId: string; event: unknown }> = []
  const systemPromptSkills: Array<unknown> = []
  const resolvedScopes: string[] = []
  const manager = new AgentSessionManager({
    resolveModel: () => ({ id: 'm1', name: 'M', provider: 'gemini', protocol: 'gemini', modelName: 'g', apiKey: 'k', baseUrl: 'https://x', temperature: 0.7, maxTokens: 100, purposes: ['generation'] }),
    resolveSystemPrompt: (_conversationId, scope, skills) => {
      resolvedScopes.push(scope)
      systemPromptSkills.push(skills)
      return 'sys'
    },
    resolveLanguage: () => 'zh-CN',
    emit: (conversationId, event) => events.push({ conversationId, event }),
    rendererAction: () => {},
    resolveConversationStore: (scope) => {
      resolvedScopes.push(scope)
      return store
    },
  })
  return { manager, events, systemPromptSkills, resolvedScopes }
}

function fakeStore(overrides: Partial<Record<keyof AgentConversationStore, unknown>> = {}) {
  const store = {
    load: vi.fn(async () => null),
    appendMessages: vi.fn(async () => {}),
    recordCompaction: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  }
  return store as unknown as AgentConversationStore & typeof store
}

beforeEach(() => {
  createPiModelsMock.mockClear()
  buildToolsMock.mockClear()
  h.sessions.length = 0
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
    expect(buildToolsMock.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('rebuilds the system prompt with the renderer skill catalog on every turn', async () => {
    const { manager, systemPromptSkills } = buildManager()
    const skills = [{ name: 'scene-craft', description: '场景塑造', location: 'managed://skills/scene-craft/SKILL.md', source: 'user' as const }]

    await manager.prompt('conv-1', 'hi')
    await manager.prompt('conv-1', 'again', undefined, undefined, undefined, skills)

    // 会话创建时先建一次初始提示词，之后每一轮都用最新目录刷新。
    expect(systemPromptSkills).toEqual([undefined, undefined, skills])
  })

  it('restores the model context from the Pi session instead of the renderer history', async () => {
    const snapshot = { messages: [{ role: 'user' as const, content: '存档里的问题', timestamp: 1 }] }
    const store = fakeStore({ load: vi.fn(async () => snapshot) })
    const { manager } = buildManager(store)

    await manager.prompt('conv-1', 'hi', undefined, undefined, [{ role: 'user', content: '渲染层的历史' }])

    expect(store.load).toHaveBeenCalledWith('conv-1')
    expect(h.sessions[0].restoreSnapshot).toHaveBeenCalledWith(snapshot)
    expect(h.sessions[0].restoreHistory).not.toHaveBeenCalled()
  })

  it('falls back to the renderer history when the Pi session has nothing stored', async () => {
    const store = fakeStore()
    const { manager } = buildManager(store)

    await manager.prompt('conv-1', 'hi', undefined, undefined, [{ role: 'user', content: '旧存档的问题' }])

    expect(h.sessions[0].restoreSnapshot).not.toHaveBeenCalled()
    expect(h.sessions[0].restoreHistory).toHaveBeenCalledWith([{ role: 'user', content: '旧存档的问题' }])
  })

  it('survives a Pi session that cannot be read', async () => {
    const store = fakeStore({ load: vi.fn(async () => { throw new Error('disk on fire') }) })
    const { manager } = buildManager(store)

    await manager.prompt('conv-1', 'hi', undefined, undefined, [{ role: 'user', content: '旧存档的问题' }])

    expect(h.sessions[0].restoreHistory).toHaveBeenCalled()
  })

  it('discards the stored session together with the conversation', async () => {
    const store = fakeStore()
    const { manager } = buildManager(store)
    await manager.prompt('conv-1', 'hi')

    expect(await manager.discard('conv-1')).toEqual({ success: true })
    expect(store.delete).toHaveBeenCalledWith('conv-1')
    expect(manager.abort('conv-1')).toEqual({ success: false })
  })

  it('resolves the app assistant store and tools for a global conversation', async () => {
    const store = fakeStore()
    const { manager, resolvedScopes } = buildManager(store)

    await manager.prompt('conv-global', 'hi', undefined, undefined, undefined, undefined, 'global')

    expect(resolvedScopes).toContain('global')
    expect(store.load).toHaveBeenCalledWith('conv-global')
  })

  it('discards a conversation from the scope it belongs to', async () => {
    const store = fakeStore()
    const { manager } = buildManager(store)

    await manager.discard('conv-global', 'global')
    expect(store.delete).toHaveBeenCalledWith('conv-global')
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
    expect(manager.abort('conv-1')).toEqual({ success: false })
  })

  it('creates a new Agent after abortAll instead of keeping the old session', async () => {
    const { manager } = buildManager()
    await manager.prompt('conv-1', 'hi')
    manager.abortAll()
    await manager.prompt('conv-1', 'again')

    expect(createPiModelsMock).toHaveBeenCalledTimes(2)
  })
})
