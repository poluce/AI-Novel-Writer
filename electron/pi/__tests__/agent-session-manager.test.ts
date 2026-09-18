import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { abortPiInFlight, resetPiInFlightForTests } from '../in-flight'
import { AgentSessionManager } from '../agent-session-manager'
import type { AgentConversationStore } from '../agent-conversation-store'

const h = vi.hoisted(() => {
  const makeSession = () => ({
    prompt: vi.fn(async () => {}),
    setEditorSnapshot: vi.fn(),
    setTools: vi.fn(async () => {}),
    setSystemPrompt: vi.fn(),
    confirm: vi.fn(),
    abort: vi.fn(),
    close: vi.fn(async () => true),
    isBusy: vi.fn(() => h.busy),
    transcriptLength: vi.fn(async () => h.transcriptLength),
    seedHistory: vi.fn(async () => {}),
    setExecutionMode: vi.fn(),
  })
  return {
    sessions: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
    transcriptLength: 0,
    busy: false,
    createdOptions: [] as Array<Record<string, unknown>>,
    makeSession,
  }
})

vi.mock('../agent-session', () => ({
  AgentSession: class {
    static create = vi.fn(async (options: Record<string, unknown>) => {
      h.createdOptions.push(options)
      const session = h.makeSession()
      h.sessions.push(session as unknown as Record<string, ReturnType<typeof vi.fn>>)
      return session
    })
  },
}))
vi.mock('../pi-models', () => ({
  createPiModels: vi.fn(() => ({ models: { streamSimple: vi.fn() }, model: {} })),
}))
vi.mock('../tool-builder', () => ({
  buildAgentTools: vi.fn(() => []),
  confirmationToolNames: vi.fn(() => new Set(['write'])),
}))

import { createPiModels } from '../pi-models'
import { buildAgentTools } from '../tool-builder'

const createPiModelsMock = createPiModels as ReturnType<typeof vi.fn>
const buildToolsMock = buildAgentTools as ReturnType<typeof vi.fn>

function buildManager(
  store: AgentConversationStore | null = null,
  resolveModel?: (modelId?: string) => Record<string, unknown> | null,
) {
  const events: Array<{ conversationId: string; event: unknown }> = []
  const systemPromptSkills: Array<unknown> = []
  const resolvedScopes: string[] = []
  const manager = new AgentSessionManager({
    resolveModel: resolveModel
      ? (modelId => resolveModel(modelId) as never)
      : () => ({ id: 'm1', name: 'M', provider: 'gemini', protocol: 'gemini', modelName: 'g', apiKey: 'k', baseUrl: 'https://x', temperature: 0.7, maxTokens: 100, purposes: ['generation'] }),
    resolveSystemPrompt: (_conversationId, _scope, skills) => {
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
    open: vi.fn(async () => ({ metadata: { id: 'conv-1' } })),
    forget: vi.fn(),
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
  h.transcriptLength = 0
  h.busy = false
  h.createdOptions.length = 0
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

  it('opens the scope session and seeds renderer history only for an empty session', async () => {
    const store = fakeStore()
    const { manager } = buildManager(store)

    await manager.prompt('conv-1', 'hi', undefined, undefined, [{ role: 'user', content: '旧存档的问题' }])

    expect(store.open).toHaveBeenCalledWith('conv-1', { create: true })
    expect(h.sessions[0].transcriptLength).toHaveBeenCalled()
    expect(h.sessions[0].seedHistory).toHaveBeenCalledWith([{ role: 'user', content: '旧存档的问题' }])
  })

  it('leaves a session with stored entries alone', async () => {
    h.transcriptLength = 4
    const store = fakeStore()
    const { manager } = buildManager(store)

    await manager.prompt('conv-1', 'hi', undefined, undefined, [{ role: 'user', content: '渲染层的历史' }])

    expect(h.sessions[0].seedHistory).not.toHaveBeenCalled()
  })

  it('reports a prompt failure when the session store cannot be opened', async () => {
    const store = fakeStore({ open: vi.fn(async () => null) })
    const { manager } = buildManager(store)

    const result = await manager.prompt('conv-1', 'hi')
    expect(result.success).toBe(false)
  })

  it('discards the stored session together with the conversation', async () => {
    const store = fakeStore()
    const { manager } = buildManager(store)
    await manager.prompt('conv-1', 'hi')

    expect(await manager.discard('conv-1')).toEqual({ success: true })
    expect(store.delete).toHaveBeenCalledWith('conv-1')
    expect(h.sessions[0].close).toHaveBeenCalled()
    // harness 关会话时也关掉了 Pi 会话，store 必须松手，下一次才打得到盘。
    expect(store.forget).toHaveBeenCalledWith('conv-1')
    expect(manager.abort('conv-1')).toEqual({ success: false })
  })

  it('resolves the app assistant store and tools for a global conversation', async () => {
    const store = fakeStore()
    const { manager, resolvedScopes } = buildManager(store)

    await manager.prompt('conv-global', 'hi', undefined, undefined, undefined, undefined, 'global')

    expect(resolvedScopes).toContain('global')
    expect(store.open).toHaveBeenCalledWith('conv-global', { create: true })
    expect(buildToolsMock).toHaveBeenCalledWith('zh-CN', expect.anything(), 'global', undefined, [])
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

  it('aborts and closes every session from abortAll', async () => {
    const { manager } = buildManager()
    await manager.prompt('conv-1', 'hi')
    await manager.prompt('conv-2', 'hi')

    manager.abortAll()
    expect(h.sessions[0].abort).toHaveBeenCalled()
    expect(h.sessions[1].abort).toHaveBeenCalled()
    expect(manager.abort('conv-1')).toEqual({ success: false })
  })

  it('creates a new Agent after abortAll instead of keeping the old session', async () => {
    const { manager } = buildManager()
    await manager.prompt('conv-1', 'hi')
    manager.abortAll()
    // 没有 store 时走内存会话：关掉之后必须还能重新开一个，而不是撞上旧 id。
    expect(await manager.prompt('conv-1', 'again')).toEqual({ success: true })

    expect(createPiModelsMock).toHaveBeenCalledTimes(2)
    expect(h.sessions).toHaveLength(2)
  })

  it('passes the requested thinking level to the session and defaults to off', async () => {
    const { manager } = buildManager()
    await manager.prompt('conv-1', 'hi')
    await manager.prompt('conv-2', 'hi', undefined, undefined, undefined, undefined, 'project', 'high')

    expect(h.createdOptions[0].thinkingLevel).toBe('off')
    expect(h.createdOptions[0].applySamplingThinking).toBe(true)
    expect(h.createdOptions[1].thinkingLevel).toBe('high')
    // 用户显式选了等级：产品侧的思考预算补丁让位。
    expect(h.createdOptions[1].applySamplingThinking).toBe(false)
  })

  it('rebuilds the session when the model changes mid-conversation', async () => {
    const models: Record<string, Record<string, unknown>> = {
      m1: { id: 'm1', name: 'M1', provider: 'gemini', protocol: 'gemini', modelName: 'g1', apiKey: 'k', baseUrl: 'https://x', temperature: 0.7, maxTokens: 100, purposes: ['generation'] },
      m2: { id: 'm2', name: 'M2', provider: 'gemini', protocol: 'gemini', modelName: 'g2', apiKey: 'k', baseUrl: 'https://x', temperature: 0.7, maxTokens: 100, purposes: ['generation'] },
    }
    const store = fakeStore()
    const { manager } = buildManager(store, modelId => models[modelId ?? 'm1'] ?? null)

    await manager.prompt('conv-1', 'hi', 'm1')
    await manager.prompt('conv-1', 'again', 'm2')

    // 换模型 = 换运行时：旧会话关掉，新会话用新档案建，存档要能重新打开
    // （对话正文在存档里，重开的会话照样带着完整历史）。
    expect(h.sessions[0].close).toHaveBeenCalled()
    expect(h.sessions).toHaveLength(2)
    expect(store.forget).toHaveBeenCalledWith('conv-1')
    expect(store.open).toHaveBeenCalledTimes(2)
    expect(createPiModelsMock).toHaveBeenCalledTimes(2)
    expect((createPiModelsMock.mock.calls[1][0] as { modelName: string }).modelName).toBe('g2')
  })

  it('rebuilds the session when the thinking level changes and reuses it when it does not', async () => {
    const { manager } = buildManager()

    await manager.prompt('conv-1', 'hi', undefined, undefined, undefined, undefined, 'project', 'low')
    await manager.prompt('conv-1', 'again', undefined, undefined, undefined, undefined, 'project', 'low')
    expect(h.sessions).toHaveLength(1)

    await manager.prompt('conv-1', 'third', undefined, undefined, undefined, undefined, 'project', 'high')
    expect(h.sessions).toHaveLength(2)
    expect(h.sessions[0].close).toHaveBeenCalled()
  })

  it('keeps the session when the runtime is unchanged but the profile disappears', async () => {
    let missing = false
    const { manager } = buildManager(null, () => (missing
      ? null
      : { id: 'm1', name: 'M', provider: 'gemini', protocol: 'gemini', modelName: 'g', apiKey: 'k', baseUrl: 'https://x', temperature: 0.7, maxTokens: 100, purposes: ['generation'] }))

    await manager.prompt('conv-1', 'hi')
    missing = true
    // 档案被删掉不该让已经打开的老会话直接失效。
    expect(await manager.prompt('conv-1', 'again')).toEqual({ success: true })
    expect(h.sessions).toHaveLength(1)
  })

  it('refuses to switch runtime while a turn is still running', async () => {
    const { manager } = buildManager()
    await manager.prompt('conv-1', 'hi')

    h.busy = true
    const result = await manager.prompt('conv-1', 'again', undefined, undefined, undefined, undefined, 'project', 'high')

    expect(result.success).toBe(false)
    expect(result.error).toContain('还在生成')
    expect(h.sessions).toHaveLength(1)
  })
})
