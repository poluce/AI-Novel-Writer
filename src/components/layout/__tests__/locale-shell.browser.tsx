/**
 * 壳层语言回归（原 locale-shell.interaction：#61 窄卡断行、#64 已挂载不刷新）。
 * 跑法改为 vitest 浏览器套件，不再自起 Vite / 本机 Chrome。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import '../../../index.css'
import WelcomePage from '../../pages/WelcomePage'
import AIPanel from '../../panels/AIPanel'
import BottomPanel from '../../panels/BottomPanel'
import { useAgentStore } from '../../../stores/agent-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import StatusBar from '../StatusBar'
import TitleBar from '../TitleBar'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const originalLocale = useLocaleStore.getState()
const originalProject = useProjectStore.getState()
const originalLayout = useLayoutStore.getState()
const originalAgent = useAgentStore.getState()
const originalWorkflow = useWorkflowStore.getState()
const originalLlm = useLLMStore.getState()

const disabledUpdateState = {
  status: 'disabled',
  currentVersion: '0.9.2',
  availableVersion: null,
  updateAction: 'none',
  isReminderDeferred: false,
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
  useProjectStore.setState({ currentProject: null, recentProjects: [] })
  useLLMStore.setState({ loaded: true, models: [], defaultModelId: null })
  useAgentStore.setState({
    conversations: [],
    activeConversationId: null,
    showHistory: false,
    toolsInitialized: true,
  })
  useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [], currentRun: null })
  useLayoutStore.setState({ bottomPanelOpen: true, bottomTab: 'models' })

  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: {
      invoke: vi.fn(async (channel: string) => {
        if (channel === 'config:set') return { success: true }
        if (channel === 'update:get-state') return disabledUpdateState
        if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
        return { success: true }
      }),
      on: vi.fn(() => () => {}),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(() => 0),
    },
  })

  container = document.createElement('div')
  container.style.width = '1440px'
  container.style.minHeight = '900px'
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useLocaleStore.setState(originalLocale, true)
  useProjectStore.setState(originalProject, true)
  useLayoutStore.setState(originalLayout, true)
  useAgentStore.setState(originalAgent, true)
  useWorkflowStore.setState(originalWorkflow, true)
  useLLMStore.setState(originalLlm, true)
  Reflect.deleteProperty(window, 'velaAPI')
})

// eslint-disable-next-line react-refresh/only-export-components -- browser-only test shell
function LocaleShell() {
  return (
    <main className="w-[1440px] min-h-[900px] overflow-hidden bg-[var(--color-editor-bg)]">
      <button
        type="button"
        data-testid="switch-to-english"
        onClick={() => void useLocaleStore.getState().setLocale('en-US')}
      >
        Switch to English
      </button>
      <TitleBar />
      <div className="grid h-[660px] grid-cols-[1fr_320px]">
        <WelcomePage onNewProject={() => {}} onOpenProject={() => {}} />
        <AIPanel />
      </div>
      <div className="h-[200px]">
        <BottomPanel />
      </div>
      <StatusBar />
    </main>
  )
}

describe('locale shell browser regression', () => {
  it('updates mounted shell components immediately and keeps the update card readable at 448px', async () => {
    await act(async () => root.render(<LocaleShell />))

    await expect.element(page.getByText('新建项目', { exact: true })).toBeVisible()
    await expect.element(page.getByRole('tab', { name: '项目助手' })).toBeVisible()
    await expect.element(page.getByText('模型调用', { exact: true })).toBeVisible()
    await expect.element(page.getByText('应用更新', { exact: true })).toBeVisible()

    await act(async () => page.getByTestId('switch-to-english').click())

    await expect.element(page.getByText('New project', { exact: true })).toBeVisible()
    await expect.element(page.getByRole('tab', { name: 'Project' })).toBeVisible()
    await expect.element(page.getByRole('tab', { name: 'App' })).toBeVisible()
    await expect.element(page.getByText('Model calls', { exact: true })).toBeVisible()
    await expect.element(page.getByText('App updates', { exact: true })).toBeVisible()
    expect(page.getByText('新建项目', { exact: true }).query()).toBeNull()
    expect(page.getByText('应用更新', { exact: true }).query()).toBeNull()
    expect(page.getByRole('tab', { name: '项目助手' }).query()).toBeNull()

    const card = page.getByRole('region', { name: 'App updates' }).element()
      .querySelector(':scope > div') as HTMLElement
    const copy = card.querySelector('div')!
    const title = copy.querySelector('span')!
    const description = copy.querySelector('p')!
    const lineCount = (element: Element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      return new Set(Array.from(range.getClientRects(), rect => Math.round(rect.top))).size
    }

    expect(Math.round(card.getBoundingClientRect().width)).toBe(448)
    expect(Math.round(copy.getBoundingClientRect().width)).toBeGreaterThan(200)
    expect(lineCount(title)).toBe(1)
    expect(lineCount(description)).toBeLessThanOrEqual(2)
  })
})
