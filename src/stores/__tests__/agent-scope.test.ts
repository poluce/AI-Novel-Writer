import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLLMStore } from '../llm-store'
import { useLocaleStore } from '../locale-store'
import { useProjectStore } from '../project-store'
import { handleAgentEvent, useAgentStore } from '../agent-store'

const ipcInvoke = vi.hoisted(() => vi.fn())
const ipcOn = vi.hoisted(() => vi.fn(() => () => {}))

vi.mock('../../services/ipc-client', () => ({
  ipc: {
    invoke: ipcInvoke,
    on: ipcOn,
    once: vi.fn(),
    send: vi.fn(),
    invokeWithProjectSession: vi.fn(),
  },
}))

/** 渲染层监听的事件回调：用来模拟主进程推送。 */
const listeners = new Map<string, (payload: never) => void>()

function resetAgentState(): void {
  useAgentStore.setState({
    conversations: [],
    activeScope: 'project',
    scopeActiveConversationIds: { project: null, global: null },
    activeConversationId: null,
    activeRequestId: null,
    toolsInitialized: true,
    composerCitations: [],
    showHistory: false,
  })
}

beforeEach(() => {
  listeners.clear()
  ipcOn.mockImplementation(((channel: string, callback: (payload: never) => void) => {
    listeners.set(channel, callback)
    return () => listeners.delete(channel)
  }) as never)
  ipcInvoke.mockReset()
  ipcInvoke.mockResolvedValue({ success: true })
  resetAgentState()
  useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
  useLLMStore.setState({ defaultModelId: 'model-a' })
  useProjectStore.setState({ currentProject: null })
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `uuid-${Math.random()}`) })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('agent scope', () => {
  it('tags new conversations with the scope that is showing and remembers the active one per scope', () => {
    const project = useAgentStore.getState().createConversation()
    expect(project.scope).toBe('project')

    useAgentStore.getState().setScope('global')
    const globalConv = useAgentStore.getState().createConversation()
    expect(globalConv.scope).toBe('global')
    expect(useAgentStore.getState().activeConversationId).toBe(globalConv.id)

    // 切回项目助手时还原它自己的活跃会话，而不是停在界面助手那条。
    useAgentStore.getState().setScope('project')
    expect(useAgentStore.getState().activeConversationId).toBe(project.id)
    expect(useAgentStore.getState().getActiveConversation()?.scope).toBe('project')
  })

  it('clears and deletes only the scope that is showing', async () => {
    const project = useAgentStore.getState().createConversation()
    useAgentStore.getState().setScope('global')
    const globalConv = useAgentStore.getState().createConversation()

    useAgentStore.getState().clearAll()

    const state = useAgentStore.getState()
    expect(state.conversations.map(c => c.id)).toEqual([project.id])
    expect(ipcInvoke).toHaveBeenCalledWith('agent:discard-session', globalConv.id, 'global')
    expect(ipcInvoke).not.toHaveBeenCalledWith('agent:discard-session', project.id, 'project')

    useAgentStore.getState().deleteConversation(project.id)
    expect(ipcInvoke).toHaveBeenCalledWith('agent:discard-session', project.id, 'project')
    expect(useAgentStore.getState().conversations).toHaveLength(0)
  })

  it('sends each conversation with its own scope', async () => {
    useAgentStore.getState().setScope('global')
    const globalConv = useAgentStore.getState().createConversation()
    await useAgentStore.getState().sendMessage('界面助手的提问')
    const globalPrompt = ipcInvoke.mock.calls.find(([channel]) => channel === 'agent:prompt')
    expect(globalPrompt?.[1]).toBe(globalConv.id)
    expect(globalPrompt?.[7]).toBe('global')

    ipcInvoke.mockClear()
    useAgentStore.getState().setScope('project')
    const projectConv = useAgentStore.getState().createConversation()
    await useAgentStore.getState().sendMessage('项目里的提问')
    const projectPrompt = ipcInvoke.mock.calls.find(([channel]) => channel === 'agent:prompt')
    expect(projectPrompt?.[1]).toBe(projectConv.id)
    expect(projectPrompt?.[7]).toBe('project')
  })

  it('keeps updating a conversation that is not the visible one', async () => {
    useAgentStore.getState().setScope('global')
    const globalConv = useAgentStore.getState().createConversation()
    await useAgentStore.getState().sendMessage('先问一句')

    // 用户切回项目助手，界面助手的这轮仍在后台跑。
    useAgentStore.getState().setScope('project')
    expect(useAgentStore.getState().activeConversationId).toBeNull()
    handleAgentEvent({
      conversationId: globalConv.id,
      event: { type: 'text_delta', delta: '后台仍然在写' },
    })

    const updated = useAgentStore.getState().conversations
      .find(c => c.id === globalConv.id)
    expect(updated?.messages.at(-1)?.content).toContain('后台仍然在写')
  })
})
