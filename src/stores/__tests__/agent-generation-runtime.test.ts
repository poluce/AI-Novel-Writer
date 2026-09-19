import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLLMStore } from '../llm-store'
import { useLocaleStore } from '../locale-store'
import { useProjectStore } from '../project-store'
import { selectIsGenerating, useAgentStore } from '../agent-store'

const ipcInvoke = vi.hoisted(() => vi.fn())

vi.mock('../../services/ipc-client', () => ({
  ipc: {
    invoke: ipcInvoke,
    on: vi.fn(() => () => {}),
    once: vi.fn(),
    send: vi.fn(),
    invokeWithProjectSession: vi.fn(),
  },
}))

describe('Agent IPC bridge', () => {
  beforeEach(() => {
    useAgentStore.setState({
      activeScope: 'project',
      conversations: [],
      activeConversationId: null,
      activeRequestId: null,
      toolsInitialized: true,
      composerCitations: [],
    })
    useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
    useLLMStore.setState({ defaultModelId: 'model-a' })
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'uuid') })
    ipcInvoke.mockReset()
  })

  afterEach(() => {
    useProjectStore.setState({ currentProject: null })
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('sendMessage invokes agent:prompt with the conversation, content, and model', async () => {
    ipcInvoke.mockResolvedValue({ success: true })
    const conversation = useAgentStore.getState().createConversation()
    useAgentStore.getState().setModelId('model-a')

    await useAgentStore.getState().sendMessage('检查项目')

    expect(ipcInvoke).toHaveBeenCalledWith(
      'agent:prompt',
      conversation.id,
      '检查项目',
      'model-a',
      expect.any(Object),
      [],
      // 技能目录随每一轮发给主进程，供系统提示词列出可用技能。
      expect.any(Array),
      // 会话属于哪个助手：项目助手 / 界面助手。
      'project',
      // 没选思考等级就不传，主进程按 Pi 默认的 off 处理。
      undefined,
      'plan',
    )
  })

  it('sends the conversation thinking level and keeps it when the model changes', async () => {
    ipcInvoke.mockResolvedValue({ success: true })
    useAgentStore.getState().createConversation()
    useAgentStore.getState().setThinkingLevel('high')
    useAgentStore.getState().setModelId('model-b')

    await useAgentStore.getState().sendMessage('写一段')

    const sent = ipcInvoke.mock.calls.find(call => call[0] === 'agent:prompt')
    expect(sent?.[3]).toBe('model-b')
    // 换渠道不该丢掉用户选的思考等级。
    expect(sent?.[8]).toBe('high')
  })

  it('prepends composer draft citations to the outgoing user message', async () => {
    ipcInvoke.mockResolvedValue({ success: true })
    useAgentStore.getState().createConversation()
    useAgentStore.getState().addComposerCitation({
      id: 'cite-1',
      chapterNumber: 3,
      version: 2,
      fromLine: 41,
      toLine: 44,
      quote: '他走了。',
    })

    await useAgentStore.getState().sendMessage('改成他会说的话')

    const sent = ipcInvoke.mock.calls.find(call => call[0] === 'agent:prompt')
    expect(String(sent?.[2])).toContain('【草稿引用 — 第3章 · v2 · 第41–44行】')
    expect(String(sent?.[2])).toContain('「他走了。」')
    expect(String(sent?.[2])).toContain('改成他会说的话')
    expect(useAgentStore.getState().composerCitations).toEqual([])
  })

  it('creates the default conversation and /help response entirely in the frozen English UI locale', async () => {
    useLocaleStore.setState({ locale: 'en-US', initialized: true })

    await useAgentStore.getState().sendMessage('/help')

    const conversation = useAgentStore.getState().getActiveConversation()
    expect(conversation?.title).toBe('New conversation')
    expect(conversation?.messages.at(-1)?.content).toContain('### Available commands')
    expect(conversation?.messages.at(-1)?.content).toContain('Show available commands and features')
    expect(conversation?.messages.at(-1)?.content).toContain('Mentions are not prefetched into the message.')
    expect(conversation?.messages.at(-1)?.content).not.toMatch(/[\u3400-\u9fff]/u)
  })

  it('sends @ mentions as user text without prefetching tool results', async () => {
    ipcInvoke.mockResolvedValue({ success: true })

    await useAgentStore.getState().sendMessage('@角色 帮我看看林舟')

    expect(ipcInvoke).toHaveBeenCalledWith(
      'agent:prompt',
      expect.any(String),
      '@角色 帮我看看林舟',
      undefined,
      expect.any(Object),
      [],
      expect.any(Array),
      'project',
      undefined,
      'plan',
    )
  })

  it('ships the skill catalog even when the registry starts loading with this first message', async () => {
    // 清空会话后发第一条：会话是这时才建的，技能注册表也跟着才开始加载。
    // 系统提示词里的技能目录必须在发送前等到加载完成，不能读空注册表。
    const { skillRegistry } = await import('../../services/agent/skill-registry')
    skillRegistry.clear()
    useAgentStore.setState({ toolsInitialized: false })
    ipcInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'skills:load-user-catalog') {
        return {
          skills: [{
            name: 'scene-craft',
            description: '场景塑造',
            content: '正文',
            baseDir: 'managed://skills/scene-craft',
            filePath: 'managed://skills/scene-craft/SKILL.md',
            source: 'user',
            language: 'zh-CN',
            stage: 'drafting',
            compatible: true,
            reasons: [],
            suggestedStage: 'drafting',
            utf8Bytes: 6,
          }],
          diagnostics: [],
        }
      }
      return { success: true }
    })

    await useAgentStore.getState().sendMessage('看看技能')

    const promptCall = ipcInvoke.mock.calls.find(([channel]) => channel === 'agent:prompt')
    const catalog = promptCall?.[6] as Array<{ name: string }>
    expect(catalog.map(item => item.name)).toContain('scene-craft')
    expect(catalog.length).toBeGreaterThan(1)
  })

  it('derives generating from the active conversation streaming message', async () => {
    let resolvePrompt: ((value: { success: boolean }) => void) | undefined
    ipcInvoke.mockImplementation(() => new Promise(resolve => {
      resolvePrompt = resolve
    }))

    const pending = useAgentStore.getState().sendMessage('Keep writing')
    await vi.waitFor(() => {
      expect(selectIsGenerating(useAgentStore.getState())).toBe(true)
    })
    expect(useAgentStore.getState()).not.toHaveProperty('generating')

    resolvePrompt?.({ success: true })
    await pending
    expect(selectIsGenerating(useAgentStore.getState())).toBe(false)
  })

  it('surfaces an empty successful turn instead of leaving a blank streaming bubble', async () => {
    useLocaleStore.setState({ locale: 'en-US', initialized: true })
    ipcInvoke.mockResolvedValue({ success: true })

    await useAgentStore.getState().sendMessage('Keep writing')

    const last = useAgentStore.getState().getActiveConversation()?.messages.at(-1)
    expect(last?.streaming).toBe(false)
    expect(last?.content).toContain('~/.vela/logs/vela.log')
  })

  it('shows a generic failure when agent:prompt reports an error', async () => {
    useLocaleStore.setState({ locale: 'en-US', initialized: true })
    ipcInvoke.mockResolvedValue({ success: false, error: 'provider-secret-runtime-failure' })

    await useAgentStore.getState().sendMessage('Please inspect the project')

    const content = useAgentStore.getState().getActiveConversation()?.messages.at(-1)?.content ?? ''
    expect(content).toBe('Generation failed. Please try again.')
    expect(content).not.toContain('provider-secret-runtime-failure')
  })

  it('cancelGeneration invokes agent:abort and closes the streaming message', async () => {
    useLocaleStore.setState({ locale: 'en-US', initialized: true })
    ipcInvoke.mockImplementation((channel: string) => {
      if (channel === 'agent:prompt') return new Promise(() => {})
      return Promise.resolve({ success: true })
    })
    useAgentStore.getState().createConversation()
    void useAgentStore.getState().sendMessage('Keep writing')
    await vi.waitFor(() => {
      expect(selectIsGenerating(useAgentStore.getState())).toBe(true)
    })

    await useAgentStore.getState().cancelGeneration()

    expect(ipcInvoke).toHaveBeenCalledWith('agent:abort', expect.any(String))
    expect(useAgentStore.getState().getActiveConversation()?.messages.at(-1)?.content)
      .toContain('_(Generation stopped)_')
    expect(selectIsGenerating(useAgentStore.getState())).toBe(false)
  })

  it('resolveToolConfirmation invokes agent:confirm', async () => {
    ipcInvoke.mockResolvedValue({ success: true })
    useAgentStore.getState().createConversation()
    await useAgentStore.getState().sendMessage('Do something')

    useAgentStore.getState().resolveToolConfirmation('call-1', true)

    expect(ipcInvoke).toHaveBeenCalledWith('agent:confirm', expect.any(String), 'call-1', true)
  })
})
