import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'

import '../../../index.css'
import CodeMirrorEditor from '../CodeMirrorEditor'
import type { DraftAnnotation } from '../../../shared/draft-annotation'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const BODY = '数据库中的旧稿正文，后面还有一段。'
const ANNOTATION: DraftAnnotation = {
  id: 'a1',
  from: 0,
  to: 5,
  quote: '数据库中的',
  note: '这段要改',
  createdAt: 1,
}

let root: Root
let container: HTMLDivElement

function setReactInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  container = document.createElement('div')
  container.style.height = '300px'
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('CodeMirrorEditor draft annotations', () => {
  it('marks the annotated range and clears the note draft when the selection changes', async () => {
    const onAnnotationsChange = vi.fn()
    await act(async () => root.render(
      <CodeMirrorEditor
        content={BODY}
        mode="prose"
        enableAnnotations
        annotations={[ANNOTATION]}
        onAnnotationsChange={onAnnotationsChange}
      />,
    ))

    // 批注装饰由 annotationCompartment 在绘制前写入，不需要额外一次渲染。
    await vi.waitFor(() => {
      expect(container.querySelectorAll('.cm-draft-annotation')).toHaveLength(1)
    })

    const view = EditorView.findFromDOM(container.querySelector('.cm-editor')!)!
    await act(async () => {
      view.dispatch({ selection: { anchor: 0, head: 5 } })
    })

    const noteInput = await vi.waitFor(() => {
      const input = container.querySelector<HTMLInputElement>('input[aria-label="选区标注"]')
      expect(input).toBeTruthy()
      return input!
    })
    await act(async () => setReactInputValue(noteInput, '这里要重写'))
    expect(noteInput.value).toBe('这里要重写')

    // 换一个选区：草稿属于上一个选区，必须被丢掉。
    await act(async () => {
      view.dispatch({ selection: { anchor: 6, head: 10 } })
    })
    await vi.waitFor(() => expect(noteInput.value).toBe(''))
  })

  it('keeps the note draft while the selection stays on the same range', async () => {
    await act(async () => root.render(
      <CodeMirrorEditor content={BODY} mode="prose" enableAnnotations annotations={[]} />,
    ))

    const view = EditorView.findFromDOM(container.querySelector('.cm-editor')!)!
    await act(async () => {
      view.dispatch({ selection: { anchor: 0, head: 5 } })
    })
    const noteInput = await vi.waitFor(() => {
      const input = container.querySelector<HTMLInputElement>('input[aria-label="选区标注"]')
      expect(input).toBeTruthy()
      return input!
    })
    await act(async () => setReactInputValue(noteInput, '别丢我'))
    // 同一选区上的文档更新（例如滚动、重绘）不该清掉正在输入的批注。
    await act(async () => {
      view.dispatch({ selection: { anchor: 0, head: 5 } })
    })
    expect(noteInput.value).toBe('别丢我')
  })
})
