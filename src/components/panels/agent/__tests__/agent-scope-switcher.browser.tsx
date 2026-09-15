import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAgentStore } from '../../../../stores/agent-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useMCPStore } from '../../../../stores/mcp-store'
import { useProjectStore } from '../../../../stores/project-store'
import AgentHeader from '../AgentHeader'

let container: HTMLDivElement
let root: Root
const originalAgentState = useAgentStore.getState()
const originalLocaleState = useLocaleStore.getState()
const originalMCPState = useMCPStore.getState()
const originalProjectState = useProjectStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function tab(name: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find(button => button.textContent?.includes(name))
}

beforeEach(() => {
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `uuid-${Math.random()}`) })
  useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
  useMCPStore.setState({ servers: [], tools: [] })
  useAgentStore.setState({
    conversations: [],
    activeScope: 'project',
    scopeActiveConversationIds: { project: null, global: null },
    activeConversationId: null,
    showHistory: false,
    toolsInitialized: true,
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useAgentStore.setState(originalAgentState, true)
  useLocaleStore.setState(originalLocaleState, true)
  useMCPStore.setState(originalMCPState, true)
  useProjectStore.setState(originalProjectState, true)
  vi.unstubAllGlobals()
})

describe('assistant scope switcher', () => {
  it('offers only the app assistant while no project is open', async () => {
    useProjectStore.setState({ currentProject: null })
    await act(async () => root.render(<AgentHeader />))

    expect(tab('项目助手')?.disabled).toBe(true)
    expect(tab('界面助手')?.disabled).toBe(false)

    await act(async () => tab('界面助手')?.click())
    expect(useAgentStore.getState().activeScope).toBe('global')

    // 项目助手此时点不动，仍停在界面助手。
    await act(async () => tab('项目助手')?.click())
    expect(useAgentStore.getState().activeScope).toBe('global')
  })

  it('switches between the two assistants once a project is open', async () => {
    useProjectStore.setState({
      currentProject: {
        id: 'p1',
        name: '潮门',
        path: 'C:\\novels\\chaomen',
        novelConfig: { writingLanguage: 'zh-CN' },
      },
    } as never)
    await act(async () => root.render(<AgentHeader />))

    expect(tab('项目助手')?.disabled).toBe(false)
    expect(tab('项目助手')?.getAttribute('aria-selected')).toBe('true')

    await act(async () => tab('界面助手')?.click())
    expect(useAgentStore.getState().activeScope).toBe('global')
    expect(tab('界面助手')?.getAttribute('aria-selected')).toBe('true')

    await act(async () => tab('项目助手')?.click())
    expect(useAgentStore.getState().activeScope).toBe('project')
  })
})
