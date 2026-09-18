/**
 * 草稿批注：装饰、区间重映射与增删的收口。
 *
 * 从 CodeMirrorEditor 抽出来的业务层。编辑器内核只该回答两件事——「给我一份装饰」
 * 和「文档变了」；批注自己的状态、上限与"原文改动后标注该落在哪"的规则都在这里，
 * 不再和引擎配置挤在同一个组件里。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { ReactCodeMirrorRef, ViewUpdate } from '@uiw/react-codemirror'
import { Compartment } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import {
  MAX_DRAFT_ANNOTATIONS,
  MAX_DRAFT_ANNOTATION_NOTE,
  type DraftAnnotation,
} from '../../shared/draft-annotation'

/** 批注高亮的装饰集；越界或空区间的批注直接丢掉。 */
export function annotationDecorations(
  annotations: readonly DraftAnnotation[],
  docLength = Number.POSITIVE_INFINITY,
) {
  return Decoration.set(
    annotations
      .filter(item => item.from >= 0 && item.to > item.from && item.to <= docLength)
      .sort((left, right) => left.from - right.from || left.to - right.to)
      .map(item => Decoration.mark({ class: 'cm-draft-annotation' }).range(item.from, item.to)),
    true,
  )
}

/**
 * 文档改动后把批注区间跟着映射；映射后对不上原文就按原文重新定位，
 * 再找不到就退化成 -1/-1（渲染时会被丢掉，但记录还在，交给用户处置）。
 */
function remapAnnotation(annotation: DraftAnnotation, update: ViewUpdate): DraftAnnotation {
  const from = update.changes.mapPos(annotation.from, 1)
  const to = update.changes.mapPos(annotation.to, -1)
  const doc = update.state.doc
  if (from < to && from <= doc.length && to <= doc.length && doc.sliceString(from, to) === annotation.quote) {
    return from === annotation.from && to === annotation.to ? annotation : { ...annotation, from, to }
  }
  const index = doc.toString().indexOf(annotation.quote)
  if (index >= 0) {
    return { ...annotation, from: index, to: index + annotation.quote.length }
  }
  if (annotation.from === -1 && annotation.to === -1) return annotation
  return { ...annotation, from: -1, to: -1 }
}

export function useDraftAnnotations({
  viewRef,
  annotations,
  enabled,
  onChange,
  selectionRange,
}: {
  viewRef: RefObject<ReactCodeMirrorRef | null>
  annotations: readonly DraftAnnotation[]
  enabled: boolean
  onChange?: (annotations: DraftAnnotation[]) => void
  selectionRange: { from: number; to: number } | null
}) {
  const [compartment] = useState(() => new Compartment())
  const [note, setNote] = useState('')
  const inputFocusedRef = useRef(false)

  // 用被动 effect：CodeMirror 的 view 是在子组件的 effect 里建的，父组件要等它建好
  // 之后才能 reconfigure（批注在真实流程里本来就是异步加载完才到）。
  useEffect(() => {
    const view = viewRef.current?.view
    if (!view) return
    view.dispatch({
      effects: compartment.reconfigure(
        EditorView.decorations.of(annotationDecorations(annotations, view.state.doc.length)),
      ),
    })
  }, [compartment, annotations, viewRef])

  /** 文档变化后重映射批注；位置真的变了才回写，避免无谓的重渲染。 */
  const remapOnDocChange = useCallback((update: ViewUpdate) => {
    if (!enabled || annotations.length === 0 || !onChange) return
    const next = annotations.map(item => remapAnnotation(item, update))
    if (next.some((item, index) => item.from !== annotations[index]?.from || item.to !== annotations[index]?.to)) {
      onChange(next)
    }
  }, [annotations, enabled, onChange])

  /** 选区换了就丢掉半路输入的草稿（草稿属于上一个选区）。 */
  const clearDraft = useCallback(() => setNote(''), [])

  /**
   * 把当前草稿落成一条批注。成功返回 true，由调用方决定随后的界面收尾
   * （关浮动条、清选区）——那是浮动条的事，不该由批注层代劳。
   */
  const addAnnotation = useCallback((): boolean => {
    const view = viewRef.current?.view
    if (!enabled || !onChange || !selectionRange || !view) return false
    const trimmed = note.trim()
    if (!trimmed) return false
    if (annotations.length >= MAX_DRAFT_ANNOTATIONS) return false
    const quote = view.state.sliceDoc(selectionRange.from, selectionRange.to)
    if (!quote.trim()) return false

    onChange([
      ...annotations,
      {
        id: crypto.randomUUID(),
        from: selectionRange.from,
        to: selectionRange.to,
        quote,
        note: trimmed.slice(0, MAX_DRAFT_ANNOTATION_NOTE),
        createdAt: Date.now(),
      },
    ])
    setNote('')
    view.dispatch({ selection: { anchor: selectionRange.to } })
    return true
  }, [annotations, enabled, note, onChange, selectionRange, viewRef])

  return {
    compartment,
    note,
    setNote,
    inputFocusedRef,
    clearDraft,
    remapOnDocChange,
    addAnnotation,
    atLimit: annotations.length >= MAX_DRAFT_ANNOTATIONS,
  }
}
