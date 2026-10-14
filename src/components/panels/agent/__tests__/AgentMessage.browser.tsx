import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'

import { useLocaleStore } from '../../../../stores/locale-store'
import AgentMessage from '../AgentMessage'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('AgentMessage copy action', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    useLocaleStore.setState({ locale: 'en-US', initialized: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it.each(['user', 'assistant'] as const)('copies only the visible %s message content', async (role) => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await act(async () => root.render(<AgentMessage message={{
      id: `${role}-1`, role, content: 'Visible message', createdAt: 1,
      ...(role === 'assistant' ? { toolCalls: [{
        id: 'hidden-tool', toolName: 'write', arguments: { secret: 'do not copy' }, status: 'completed' as const,
      }] } : {}),
    }} />))

    await act(async () => page.getByRole('button', { name: 'Copy message' }).click())

    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText).toHaveBeenCalledWith('Visible message')
  })

  it('disables copying for empty streaming content', async () => {
    await act(async () => root.render(<AgentMessage message={{
      id: 'streaming', role: 'assistant', content: '', createdAt: 1, streaming: true,
    }} />))

    expect(page.getByRole('button', { name: 'Copy message' })).toBeDisabled()
  })

  it('shows a localized clipboard failure without hiding the message', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('clipboard denied'))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await act(async () => root.render(<AgentMessage message={{
      id: 'assistant-1', role: 'assistant', content: 'Keep this visible', createdAt: 1,
    }} />))

    await act(async () => page.getByRole('button', { name: 'Copy message' }).click())

    expect(page.getByRole('alert')).toHaveTextContent('Could not copy this message')
    expect(container.textContent).toContain('Keep this visible')
  })
})

describe('AgentMessage tool calls display (Option B: Collapsible summary above content)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('renders tool calls in a collapsed summary bar positioned ABOVE the content', async () => {
    await act(async () => root.render(<AgentMessage message={{
      id: 'assistant-1',
      role: 'assistant',
      content: '这里是正文结论',
      createdAt: 1,
      toolCalls: [{
        id: 'tc-1',
        toolName: 'web_fetch',
        arguments: { url: 'https://example.com' },
        status: 'completed',
      }],
    }} />))

    // The summary bar should show executed tool count and tool name
    const summaryBtn = page.getByRole('button', { name: /已执行 1 个操作/ })
    await expect.element(summaryBtn).toBeVisible()
    expect(summaryBtn.element().textContent).toContain('web_fetch')
    expect(summaryBtn.element().textContent).toContain('详情')

    // In DOM order, the tool calls summary precedes the content
    const fullText = container.textContent || ''
    const toolIndex = fullText.indexOf('已执行 1 个操作')
    const contentIndex = fullText.indexOf('这里是正文结论')
    expect(toolIndex).toBeGreaterThan(-1)
    expect(contentIndex).toBeGreaterThan(toolIndex)

    // Initially collapsed: ToolCallBlock details shouldn't be expanded
    expect(container.querySelector('.tool-call-block')).toBeNull()

    // Clicking the summary bar expands the details
    await act(async () => summaryBtn.click())
    expect(container.querySelector('.tool-call-block')).not.toBeNull()
    expect(summaryBtn.element().textContent).toContain('收起')

    // Clicking again collapses it
    await act(async () => summaryBtn.click())
    expect(container.querySelector('.tool-call-block')).toBeNull()
  })

  it('auto-reveals confirmation card when tool call is in waiting_confirm', async () => {
    await act(async () => root.render(<AgentMessage message={{
      id: 'assistant-2',
      role: 'assistant',
      content: '等待作者确认',
      createdAt: 1,
      toolCalls: [{
        id: 'tc-confirm',
        toolName: 'manage_drafts',
        arguments: { chapter_number: 1, content: '新正文' },
        status: 'waiting_confirm',
      }],
    }} />))

    // The summary indicates confirmation needed
    const summaryBtn = page.getByRole('button', { name: /需要确认操作/ })
    await expect.element(summaryBtn).toBeVisible()

    // Confirm card is visible
    expect(container.textContent).toContain('manage_drafts')
  })

  it('positions the copy button below the content without colliding with the top collapsible bar', async () => {
    await act(async () => root.render(<AgentMessage message={{
      id: 'assistant-3',
      role: 'assistant',
      content: '测试正文内容',
      createdAt: 1,
      toolCalls: [{
        id: 'tc-2',
        toolName: 'web_fetch',
        arguments: {},
        status: 'completed',
      }],
    }} />))

    const copyBtn = page.getByRole('button', { name: /复制消息|Copy message/ }).element()
    const summaryBtn = page.getByRole('button', { name: /已执行 1 个操作/ }).element()

    // summaryBtn is before copyBtn in vertical document order
    expect(summaryBtn.compareDocumentPosition(copyBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // copyBtn does not have absolute top-1 class
    expect(copyBtn.className).not.toContain('top-1')
  })
})
