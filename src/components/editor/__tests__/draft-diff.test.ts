import { describe, expect, it, vi } from 'vitest'
import { buildDiffDecorations, DiffInsertionWidget, type DraftDiffProposal } from '../draft-diff'

describe('draft-diff decorations', () => {
  it('returns Decoration.none when proposals or docText are empty', () => {
    expect(buildDiffDecorations([], 'Some text')).toBeDefined()
    expect(buildDiffDecorations(undefined, 'Some text')).toBeDefined()
    expect(buildDiffDecorations([{ id: '1', oldText: 'a', newText: 'b', status: 'pending' }], '')).toBeDefined()
  })

  it('ignores proposals not in pending status or missing in docText', () => {
    const doc = '这是第一段话。这是第二段话。'
    const proposals: DraftDiffProposal[] = [
      { id: '1', oldText: '不存在的句子', newText: '新句子', status: 'pending' },
      { id: '2', oldText: '第一段话', newText: '修改段落', status: 'accepted' },
      { id: '3', oldText: '第一段话', newText: '修改段落', status: 'rejected' },
    ]
    const decoSet = buildDiffDecorations(proposals, doc)
    expect(decoSet.size).toBe(0)
  })

  it('builds deletion mark and insertion widget for pending proposals', () => {
    const doc = '阳光洒在书桌上，显得格外刺眼。他站起身来。'
    const onAccept = vi.fn()
    const onReject = vi.fn()
    const proposal: DraftDiffProposal = {
      id: 'diff-1',
      oldText: '显得格外刺眼。',
      newText: '泛着温暖的金光。',
      status: 'pending',
      onAccept,
      onReject,
    }

    const decoSet = buildDiffDecorations([proposal], doc)
    expect(decoSet.size).toBe(2) // 1 mark + 1 widget

    let markFound = false
    let widgetFound = false

    const from = doc.indexOf('显得格外刺眼。')
    const to = from + '显得格外刺眼。'.length

    decoSet.between(0, doc.length, (fromPos, toPos, value) => {
      if (fromPos === from && toPos === to && (value.spec as { class?: string }).class === 'cm-diff-deletion') {
        markFound = true
      }
      if (fromPos === to && toPos === to && (value.spec as { widget?: unknown }).widget instanceof DiffInsertionWidget) {
        widgetFound = true
      }
    })

    expect(markFound).toBe(true)
    expect(widgetFound).toBe(true)
  })

  it('DiffInsertionWidget eq behaves correctly', () => {
    const p1: DraftDiffProposal = { id: 'd1', oldText: 'a', newText: 'b', status: 'pending' }
    const p2: DraftDiffProposal = { id: 'd1', oldText: 'a', newText: 'b', status: 'pending' }
    const p3: DraftDiffProposal = { id: 'd1', oldText: 'a', newText: 'c', status: 'pending' }

    const w1 = new DiffInsertionWidget(p1, 'zh-CN')
    const w2 = new DiffInsertionWidget(p2, 'zh-CN')
    const w3 = new DiffInsertionWidget(p3, 'zh-CN')
    const w4 = new DiffInsertionWidget(p1, 'en-US')

    expect(w1.eq(w2)).toBe(true)
    expect(w1.eq(w3)).toBe(false)
    expect(w1.eq(w4)).toBe(false)
  })
})
