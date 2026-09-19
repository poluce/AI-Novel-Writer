import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAgentStore, type AgentConversation } from '../../../../stores/agent-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import type { ModelProfile } from '../../../../shared/ipc-channels'
import AgentInputBox from '../AgentInputBox'

let container: HTMLDivElement
let root: Root
const originalAgentState = useAgentStore.getState()
const originalLLMState = useLLMStore.getState()
const originalLocaleState = useLocaleStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function profile(overrides: Partial<ModelProfile> & { id: string; modelName: string }): ModelProfile {
  return {
    name: overrides.modelName,
    provider: 'gemini',
    protocol: 'gemini',
    apiKey: 'k',
    baseUrl: 'https://relay.example/antigravity',
    temperature: 0.7,
    maxTokens: 65530,
    purposes: ['generation'],
    ...overrides}
}

/** 一条会话：模型与思考等级都是会话级的，这里从"都没选"开始。 */
function conversation(): AgentConversation {
  return {
    id: 'conv-1',
    title: '新对话',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    mode: 'planning',
    modelId: null,
    thinkingLevel: null,
    scope: 'project'}
}

function buttonWithText(fragment: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent?.includes(fragment))
}

async function click(target: HTMLElement | undefined): Promise<void> {
  await act(async () => {
    target?.click()
  })
}

beforeEach(() => {
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `uuid-${Math.random()}`) })
  useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
  useAgentStore.setState({
    conversations: [conversation()],
    activeConversationId: 'conv-1',
    activeRequestId: null,
    composerCitations: [],
    toolsInitialized: true})
  useLLMStore.setState({
    // 同一渠道下两个模型 + 另一个渠道一个模型：菜单要按渠道分两层。
    models: [
      profile({ id: 'p1', modelName: 'gemini-3.8-flash-low' }),
      profile({ id: 'p2', modelName: 'gemini-3.1-pro-low' }),
      profile({ id: 'p3', modelName: 'gpt-5', provider: 'openai', protocol: 'openai', baseUrl: 'https://api.openai.com/v1' }),
    ],
    defaultModelId: 'p1'})
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useAgentStore.setState(originalAgentState, true)
  useLLMStore.setState(originalLLMState, true)
  useLocaleStore.setState(originalLocaleState, true)
  vi.unstubAllGlobals()
})

describe('assistant composer runtime pickers', () => {
  it('groups the saved models by channel and switches the conversation model (DSH two-level menu)', async () => {
    await act(async () => root.render(<AgentInputBox />))
    // 触发按钮上同时显示当前模型名和思考档（未指定时为「关」）
    const trigger = buttonWithText('gemini-3.8-flash-low')
    expect(trigger).toBeDefined()
    expect(trigger?.textContent).toContain('关')

    // 1. 点击触发器，打开 DSH 根菜单
    await click(buttonWithText('gemini-3.8-flash-low'))
    expect(buttonWithText('模型')).toBeDefined()
    expect(buttonWithText('思考')).toBeDefined()

    // 2. 点击「模型」，进入模型子面板
    await click(buttonWithText('模型'))
    expect(container.textContent).toContain('选择模型')
    // 两个渠道各有一个分组标题，模型挂在各自渠道下面
    expect(container.textContent).toContain('relay.example')
    expect(container.textContent).toContain('api.openai.com')
    expect(container.textContent).toContain('gemini-3.1-pro-low')
    expect(container.textContent).toContain('gpt-5')

    // 3. 点击「gemini-3.1-pro-low」选中该模型
    await click(buttonWithText('gemini-3.1-pro-low'))

    const active = useAgentStore.getState().getActiveConversation()
    expect(active?.modelId).toBe('p2')
    expect(useLLMStore.getState().taskModelRouting['assistant']?.modelId).toBe('p2')
    // 菜单收起后触发按钮更新为新选中的模型
    expect(buttonWithText('gemini-3.1-pro-low')).toBeDefined()
  })

  it('navigates the effort sub-pane to change thinking level and reflects on the trigger button badge', async () => {
    await act(async () => root.render(<AgentInputBox />))
    const trigger = buttonWithText('gemini-3.8-flash-low')
    expect(trigger).toBeDefined()

    // 1. 点击触发器，进入根菜单，点击「思考」进入思考子面板
    await click(trigger)
    await click(buttonWithText('思考'))
    expect(container.textContent).toContain('思考等级')

    const high = container.querySelector<HTMLButtonElement>('[data-thinking-level="high"]')
    expect(high).not.toBeNull()

    // 2. 选中「高」
    await click(high ?? undefined)

    expect(useAgentStore.getState().getActiveConversation()?.thinkingLevel).toBe('high')
    // 触发按钮上带「高」字徽标
    expect(container.textContent).toContain('高')

    // 3. 再次打开并切回默认档「关（默认）」
    await click(buttonWithText('gemini-3.8-flash-low'))
    await click(buttonWithText('思考'))
    await click(container.querySelector<HTMLButtonElement>('[data-thinking-level="default"]') ?? undefined)

    expect(useAgentStore.getState().getActiveConversation()?.thinkingLevel).toBeNull()
    expect(buttonWithText('gemini-3.8-flash-low')?.textContent).toContain('关')
  })
})
