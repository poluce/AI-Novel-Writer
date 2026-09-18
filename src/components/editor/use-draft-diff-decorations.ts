/**
 * 行内修订（draft diff）的装饰生命周期。
 *
 * 与 `use-draft-diff-proposals.ts` 的分工：那个负责"从助手会话里捞出待确认的修订提案"，
 * 这个负责"把提案画进编辑器、并在该看的时候把视口带过去"。editor 组件只拿一个
 * compartment 去挂初值，不再自己管重配与滚动。
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { Compartment } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { Locale } from '../../i18n/types'
import { buildDiffDecorations, type DraftDiffProposal } from './draft-diff'

export function useDraftDiffDecorations({
  viewRef,
  proposals,
  content,
  locale,
  scrollToRequestId,
}: {
  viewRef: RefObject<ReactCodeMirrorRef | null>
  proposals?: readonly DraftDiffProposal[]
  content: string
  locale: Locale
  scrollToRequestId?: number
}) {
  const [compartment] = useState(() => new Compartment())
  const prevCountRef = useRef(0)

  // 提案或正文变了就重配装饰（不重建整个 extensions，否则等于重置编辑器）。
  useEffect(() => {
    const view = viewRef.current?.view
    if (!view) return
    view.dispatch({
      effects: compartment.reconfigure(
        EditorView.decorations.of(buildDiffDecorations(proposals, view.state.doc.toString(), locale)),
      ),
    })
  }, [compartment, proposals, content, locale, viewRef])

  // 从"没有提案"变成"有提案"时，把视口带到第一处修改。
  useEffect(() => {
    const count = proposals?.length ?? 0
    if (count > 0 && prevCountRef.current === 0 && viewRef.current?.view) {
      const view = viewRef.current.view
      const first = proposals?.[0]
      if (first?.oldText) {
        const index = view.state.doc.toString().indexOf(first.oldText)
        if (index >= 0) {
          view.dispatch({ effects: EditorView.scrollIntoView(index, { y: 'center' }) })
        }
      }
    }
    prevCountRef.current = count
  }, [proposals, viewRef])

  // 外部（例如对话里的"定位到此处"）主动要求滚动并选中首处差异。
  useEffect(() => {
    if (!scrollToRequestId || !viewRef.current?.view || !proposals?.length) return
    const view = viewRef.current.view
    const first = proposals[0]
    if (first?.oldText) {
      const index = view.state.doc.toString().indexOf(first.oldText)
      if (index >= 0) {
        view.dispatch({
          effects: EditorView.scrollIntoView(index, { y: 'center' }),
          selection: { anchor: index },
        })
        view.focus()
      }
    }
  }, [scrollToRequestId, proposals, viewRef])

  return { compartment }
}
