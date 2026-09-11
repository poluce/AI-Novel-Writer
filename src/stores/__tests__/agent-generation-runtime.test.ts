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
      conversations: [],
      activeConversationId: null,
      activeRequestId: null,
      toolsInitialized: true,
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

    expect(ipcInvoke).toHaveBeenCalledWith('agent:prompt', conversation.id, '检查项目', 'model-a')
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

    expect(ipcInvoke).toHaveBeenCalledWith('agent:prompt', expect.any(String), '@角色 帮我看看林舟', undefined)
  })

  it('derives generating from the active conversation streaming message', async () => {
    ipcInvoke.mockResolvedValue({ success: true })

    await useAgentStore.getState().sendMessage('Keep writing')

    expect(selectIsGenerating(useAgentStore.getState())).toBe(true)
    expect(useAgentStore.getState()).not.toHaveProperty('generating')
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
    ipcInvoke.mockResolvedValue({ success: true })
    useAgentStore.getState().createConversation()
    await useAgentStore.getState().sendMessage('Keep writing')

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
