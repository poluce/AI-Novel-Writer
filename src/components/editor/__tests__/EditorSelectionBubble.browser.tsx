/**
 * 浮动条的独立展示用例。
 *
 * 这一步的意义：以前要验浮动条必须渲染整个 CodeMirror（还要等它挂载、拿真实选区），
 * 现在它是受控展示组件，可以直接断言文案、禁用态与回调——引擎不再挡在中间。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { MAX_DRAFT_ANNOTATIONS } from '../../../shared/draft-annotation'
import { useLocaleStore } from '../../../stores/locale-store'
import { EditorContextMenu, EditorSelectionBubble } from '../EditorSelectionBubble'
import { AI_ACTIONS, type EditorAIAction } from '../use-editor-ai-handoff'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  useLocaleStore.setState({ locale: 'zh-CN' })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useLocaleStore.setState({ locale: 'zh-CN' })
})

// eslint-disable-next-line react-refresh/only-export-components -- browser-only test shell
function Harness({
  initialNote = '',
  annotationCount = 0,
  annotationVisible = true,
  boldVisible = false,
  addToAssistantVisible = false,
  onAddAnnotation = vi.fn(),
  onAddToAssistant = vi.fn(),
  onRunAIAction = vi.fn(),
}: {
  initialNote?: string
  annotationCount?: number
  annotationVisible?: boolean
  boldVisible?: boolean
  addToAssistantVisible?: boolean
  onAddAnnotation?: () => void
  onAddToAssistant?: () => void
  onRunAIAction?: (action: EditorAIAction) => void
}) {
  const uiText = useLocaleStore(s => s.text)
  const [note, setNote] = useState(initialNote)

  return (
    <EditorSelectionBubble
      open
      position={{ top: 120, left: 240 }}
      uiText={uiText}
      annotationVisible={annotationVisible}
      annotationNote={note}
      annotationCount={annotationCount}
      onAnnotationNoteChange={setNote}
      onAnnotationInputFocusChange={() => {}}
      onAddAnnotation={onAddAnnotation}
      boldVisible={boldVisible}
      onBold={() => {}}
      addToAssistantVisible={addToAssistantVisible}
      onAddToAssistant={onAddToAssistant}
      aiActions={AI_ACTIONS}
      onRunAIAction={onRunAIAction}
    />
  )
}

describe('浮动条展示层', () => {
  it('批注为空时「标注」禁用，输入后启用并能提交', async () => {
    const onAddAnnotation = vi.fn()
    await act(async () => root.render(<Harness onAddAnnotation={onAddAnnotation} />))

    const noteButton = () => page.getByRole('button', { name: '标注' }).element() as HTMLButtonElement
    expect(noteButton().disabled).toBe(true)

    await act(async () => page.getByPlaceholder('这段有什么问题？').fill('这里的节奏太快了'))
    expect(noteButton().disabled).toBe(false)

    await act(async () => page.getByRole('button', { name: '标注' }).click())
    expect(onAddAnnotation).toHaveBeenCalledTimes(1)
  })

  it('批注数量达上限时，即使有内容也不许再标', async () => {
    await act(async () => root.render(
      <Harness initialNote="已有内容" annotationCount={MAX_DRAFT_ANNOTATIONS} />,
    ))

    const noteButton = page.getByRole('button', { name: '标注' }).element() as HTMLButtonElement
    expect(noteButton.disabled).toBe(true)
  })

  it('AI 动作按界面语言显示，点击回调带上对应动作', async () => {
    const onRunAIAction = vi.fn()
    await act(async () => root.render(<Harness onRunAIAction={onRunAIAction} />))

    for (const label of ['润色', '扩写', '续写', '对话']) {
      await expect.element(page.getByRole('button', { name: label })).toBeVisible()
    }

    await act(async () => page.getByRole('button', { name: '润色' }).click())
    expect(onRunAIAction).toHaveBeenCalledWith(expect.objectContaining({ key: 'refine' }))

    // 切语言：store 里 `text` 的响应式身份由 action 刷新，这里直接改 state，
    // 所以重新渲染一次让组件读到新的 locale（与真实切换后的行为一致）。
    await act(async () => useLocaleStore.setState({ locale: 'en-US' }))
    await act(async () => root.render(<Harness onRunAIAction={onRunAIAction} />))
    for (const label of ['Refine', 'Expand', 'Continue', 'Dialogue']) {
      await expect.element(page.getByRole('button', { name: label })).toBeVisible()
    }
    expect(page.getByRole('button', { name: '润色' }).query()).toBeNull()
  })

  it('「添加到助手」只在有该入口时渲染', async () => {
    const onAddToAssistant = vi.fn()
    await act(async () => root.render(<Harness onAddToAssistant={onAddToAssistant} />))
    expect(page.getByRole('button', { name: '添加到助手' }).query()).toBeNull()

    await act(async () => root.render(
      <Harness addToAssistantVisible onAddToAssistant={onAddToAssistant} />,
    ))
    await act(async () => page.getByRole('button', { name: '添加到助手' }).click())
    expect(onAddToAssistant).toHaveBeenCalledTimes(1)
  })

  it('未打开或位置尚未算出来时不渲染', async () => {
    await act(async () => root.render(
      <EditorSelectionBubble
        open={false}
        position={{ top: 120, left: 240 }}
        uiText={useLocaleStore.getState().text}
        annotationVisible
        annotationNote=""
        annotationCount={0}
        onAnnotationNoteChange={() => {}}
        onAnnotationInputFocusChange={() => {}}
        onAddAnnotation={() => {}}
        boldVisible={false}
        onBold={() => {}}
        addToAssistantVisible={false}
        onAddToAssistant={() => {}}
        aiActions={AI_ACTIONS}
        onRunAIAction={() => {}}
      />,
    ))
    expect(page.getByRole('button', { name: '标注' }).query()).toBeNull()
  })
})

describe('选区右键菜单', () => {
  it('按下即回调（菜单挂在 body 上，用 mousedown 才来得及）', async () => {
    const onSelect = vi.fn()
    await act(async () => root.render(
      <EditorContextMenu position={{ top: 40, left: 60 }} label="添加到助手" onSelect={onSelect} />,
    ))

    const item = page.getByRole('button', { name: '添加到助手' })
    await expect.element(item).toBeVisible()
    await act(async () => item.click())
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})
