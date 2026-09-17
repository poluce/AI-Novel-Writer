/**
 * 编辑器写作助手的派发边界（浏览器侧）。
 *
 * 2026-09 起，编辑器浮动条的润色 / 扩写 / 续写 / 对话不再自己发模型请求、
 * 也不再在编辑器内做「预览条 + 替换」，而是统一作为带选区引用的 Agent
 * Quick Task 派发给右侧助手会话（见审计文档 §6.4）。
 *
 * 这里守的就是这条新链路的界面契约：选中正文 → 点动作 → 引用进输入框、
 * 助手面板打开、提示词按当前界面语言发给助手。原先守在内联预览条上的
 * 「只读拒绝 / 原文已变拒绝」由 src/services/agent/__tests__/apply-draft-excerpt.test.ts
 * 承接，模型租约由 generation-runtime 的用例承接。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { useAgentStore } from '../../../stores/agent-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLocaleStore } from '../../../stores/locale-store'
import CodeMirrorEditor from '../CodeMirrorEditor'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REFINE_ZH_CN = '润色这部分，使语言自然、具体并增强场景表现力。'
const REFINE_EN_US = 'Refine this passage for natural, specific language and stronger scene craft.'

let root: Root
let container: HTMLDivElement
let invoke: ReturnType<typeof vi.fn>
let sendMessage: ReturnType<typeof vi.fn<(content: string) => Promise<void>>>
let originalSendMessage: ReturnType<typeof useAgentStore.getState>['sendMessage']

beforeEach(() => {
  window.getSelection()?.removeAllRanges()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)

  originalSendMessage = useAgentStore.getState().sendMessage
  sendMessage = vi.fn<(content: string) => Promise<void>>(async () => {})
  // 只替换派发入口：本用例断言的是"有没有把正确的任务交给助手"，
  // 助手内部那一轮（含 IPC）不是这里要覆盖的范围。
  useAgentStore.setState({ sendMessage, composerCitations: [] })
  useLocaleStore.setState({ locale: 'zh-CN' })

  invoke = vi.fn(async (channel: string) => {
    if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
    throw new Error(`Unexpected IPC channel: ${channel}`)
  })
  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: {
      invoke,
      on: vi.fn(() => () => {}),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(() => 0),
    },
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useAgentStore.setState({ sendMessage: originalSendMessage, composerCitations: [] })
  useLocaleStore.setState({ locale: 'zh-CN' })
  Reflect.deleteProperty(window, 'velaAPI')
})

async function selectAllAndRun(label: string, content: string) {
  await act(async () => root.render(<CodeMirrorEditor content={content} mode="prose" />))
  await act(async () => page.getByText(content).click({ clickCount: 3 }))
  await act(async () => page.getByRole('button', { name: label }).click())
}

describe('CodeMirror editor AI handoff to the assistant', () => {
  it('hands the selected passage to the assistant as a cited quick task', async () => {
    await selectAllAndRun('润色', '原文段落')

    const citations = useAgentStore.getState().composerCitations
    expect(citations).toHaveLength(1)
    expect(citations[0]).toMatchObject({ quote: '原文段落', fromLine: 1, toLine: 1 })

    expect(useLayoutStore.getState()).toMatchObject({ aiPanelOpen: true, rightView: 'agent' })
    expect(sendMessage).toHaveBeenCalledWith(REFINE_ZH_CN)
  })

  it('sends the English prompt for an English interface', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    await selectAllAndRun('Refine', 'Original passage')

    expect(useAgentStore.getState().composerCitations[0]?.quote).toBe('Original passage')
    expect(sendMessage).toHaveBeenCalledWith(REFINE_EN_US)
  })

})
