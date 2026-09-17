import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../index.css'
import CodeMirrorEditor from '../CodeMirrorEditor'
import type { DraftDiffProposal } from '../draft-diff'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const BODY = '阳光洒在书桌上，显得格外刺眼。他站起身来走向窗边。'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  container.style.height = '400px'
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('CodeMirrorEditor inline draft diff revisions', () => {
  it('renders inline red deletion, green insertion, and responds to accept/reject', async () => {
    const onAccept = vi.fn()
    const onReject = vi.fn()
    const proposal: DraftDiffProposal = {
      id: 'diff-1',
      chapterNumber: 1,
      oldText: '显得格外刺眼。',
      newText: '泛着温暖的金芒。',
      status: 'pending',
      onAccept,
      onReject,
    }

    await act(async () => {
      root.render(
        <CodeMirrorEditor
          content={BODY}
          mode="prose"
          diffProposals={[proposal]}
        />,
      )
    })

    // 1. 验证红色删除线标记
    const deletionEl = await vi.waitFor(() => {
      const el = container.querySelector<HTMLElement>('.cm-diff-deletion')
      expect(el).toBeTruthy()
      return el!
    })
    expect(deletionEl.textContent).toBe('显得格外刺眼。')

    // 2. 验证绿色新增文本
    const insertionEl = await vi.waitFor(() => {
      const el = container.querySelector<HTMLElement>('.cm-diff-insertion')
      expect(el).toBeTruthy()
      return el!
    })
    expect(insertionEl.textContent).toBe('泛着温暖的金芒。')

    // 3. 验证操作按钮（合并与放弃）
    const acceptBtn = container.querySelector<HTMLButtonElement>('.cm-diff-btn-accept')
    const rejectBtn = container.querySelector<HTMLButtonElement>('.cm-diff-btn-reject')
    expect(acceptBtn).toBeTruthy()
    expect(rejectBtn).toBeTruthy()
    expect(acceptBtn?.textContent).toContain('合并')
    expect(rejectBtn?.textContent).toContain('放弃')

    // 4. 点击合并按钮
    await act(async () => {
      acceptBtn?.click()
    })
    expect(onAccept).toHaveBeenCalledTimes(1)
    expect(onReject).not.toHaveBeenCalled()

    // 5. 点击放弃按钮
    await act(async () => {
      rejectBtn?.click()
    })
    expect(onReject).toHaveBeenCalledTimes(1)
  })

  it('clears diff decorations when diffProposals is empty', async () => {
    const proposal: DraftDiffProposal = {
      id: 'diff-1',
      oldText: '显得格外刺眼。',
      newText: '泛着温暖的金芒。',
      status: 'pending',
    }

    await act(async () => {
      root.render(
        <CodeMirrorEditor
          content={BODY}
          mode="prose"
          diffProposals={[proposal]}
        />,
      )
    })

    await vi.waitFor(() => {
      expect(container.querySelectorAll('.cm-diff-deletion')).toHaveLength(1)
    })

    // 提案结算后更新为空
    await act(async () => {
      root.render(
        <CodeMirrorEditor
          content={BODY}
          mode="prose"
          diffProposals={[]}
        />,
      )
    })

    await vi.waitFor(() => {
      expect(container.querySelectorAll('.cm-diff-deletion')).toHaveLength(0)
      expect(container.querySelectorAll('.cm-diff-insertion')).toHaveLength(0)
    })
  })
})
