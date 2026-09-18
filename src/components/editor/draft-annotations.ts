/**
 * 草稿批注的纯函数部分：装饰集与区间重映射。
 *
 * 与 `use-draft-annotations.ts`（状态与生命周期）、`editor-extensions.ts`（挂载初值）
 * 分开，是因为这两件事都不需要 React：装饰怎么建、正文改动后标注该落到哪，
 * 都是可以直接断言的规则。
 */
import type { ViewUpdate } from '@uiw/react-codemirror'
import { Decoration } from '@codemirror/view'
import type { DraftAnnotation } from '../../shared/draft-annotation'

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
export function remapAnnotation(annotation: DraftAnnotation, update: ViewUpdate): DraftAnnotation {
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
