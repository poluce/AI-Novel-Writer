/**
 * 编辑器浮动条（Bubble Menu）的存在、位置与右键菜单。
 *
 * 从 CodeMirrorEditor 抽出来的交互层：它只回答"浮动条该不该显示、显示在哪、
 * 右键菜单开了没有"，不认识批注、也不认识助手。
 *
 * 两层接缝：换了选区要丢掉半路输入的批注草稿（草稿属于上一个选区）。
 * 这里不直接调批注层，而是通过 `onSelectionChange` 回调把这件事交回调用方——
 * 接缝留在组件里，比藏进 hook 里更容易看懂。（见 `2026-09-18-editor-layering-plan.md` §3.3）
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type RefObject } from 'react'
import type { ReactCodeMirrorRef } from '@uiw/react-codemirror'

export interface EditorSelectionRange {
  from: number
  to: number
}

export interface EditorContextMenuState {
  top: number
  left: number
  from: number
  to: number
}

export function useEditorBubble({
  viewRef,
  onSelectionChange,
  contextMenuEnabled,
}: {
  viewRef: RefObject<ReactCodeMirrorRef | null>
  /** 选区真的变了才回调（同一选区重复上报不会触发）。 */
  onSelectionChange: () => void
  /** 没有"添加到助手"这个入口时，右键不该被接管。 */
  contextMenuEnabled: boolean
}) {
  const [bubbleOpen, setBubbleOpen] = useState(false)
  const [bubblePos, setBubblePos] = useState({ top: 0, left: 0 })
  const [selectionRange, setSelectionRange] = useState<EditorSelectionRange | null>(null)
  const selectionRangeRef = useRef<EditorSelectionRange | null>(null)
  const [contextMenu, setContextMenu] = useState<EditorContextMenuState | null>(null)

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [contextMenu])

  /**
   * 选区变化的唯一入口：换了选区就通知外层丢掉批注草稿，选区没变时不动它。
   * 之前靠 effect 兜这件事，会在渲染后多跑一轮。
   */
  const applySelectionRange = useCallback((next: EditorSelectionRange | null) => {
    const previous = selectionRangeRef.current
    if (previous?.from === next?.from && previous?.to === next?.to) return
    selectionRangeRef.current = next
    onSelectionChange()
    setSelectionRange(next)
  }, [onSelectionChange])

  /** 选中了一段新文字：记下选区并显示浮动条。 */
  const openBubble = useCallback((range: EditorSelectionRange) => {
    applySelectionRange(range)
    setBubbleOpen(true)
  }, [applySelectionRange])

  /** 收起浮动条并清掉选区。 */
  const closeBubble = useCallback(() => {
    setBubbleOpen(false)
    applySelectionRange(null)
  }, [applySelectionRange])

  /** 监听滚动与缩放，实时更新浮动条坐标。 */
  useEffect(() => {
    if (!bubbleOpen || !selectionRange || !viewRef.current?.view) return;

    const view = viewRef.current.view;
    const scrollDOM = view.scrollDOM;

    let rafId: number;

    const updatePosition = () => {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        const coords = view.coordsAtPos(selectionRange.from)
        if (coords) {
          setBubblePos({ top: coords.top, left: coords.left })
        } else {
          setBubbleOpen(false)
        }
        return
      }

      const range = sel.getRangeAt(0)
      const rect = range.getBoundingClientRect()
      const viewRect = scrollDOM.getBoundingClientRect()

      // 判断选区是否整体完全在视口之外
      if (rect.bottom < viewRect.top || rect.top > viewRect.bottom || rect.width === 0) {
        setBubbleOpen(false)
        return
      }

      let top = rect.top - 5 // 与选区顶部有些许间距
      const left = rect.left + rect.width / 2

      // 当用户圈选了一大段并向下滚动时，如果选区顶部滚出了视区，
      // 我们让气泡悬浮在视区顶部边缘，直到选区底部也完全滚出视区。
      if (top < viewRect.top + 45) {
        top = Math.min(viewRect.top + 45, rect.bottom - 10)
      }

      setBubblePos({ top, left })
    }

    const onScrollOrResize = () => {
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(updatePosition)
    }

    scrollDOM.addEventListener('scroll', onScrollOrResize, { passive: true })
    window.addEventListener('resize', onScrollOrResize, { passive: true })

    // 初始化计算需要等待 CM 渲染映射完成，确保获取到正确的 DOM Range
    rafId = requestAnimationFrame(updatePosition)

    return () => {
      scrollDOM.removeEventListener('scroll', onScrollOrResize)
      window.removeEventListener('resize', onScrollOrResize)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [bubbleOpen, selectionRange, viewRef])

  /** 选区上的右键：收起浮动条，改在光标处开菜单。 */
  const handleContextMenu = useCallback((event: MouseEvent) => {
    if (!contextMenuEnabled || !viewRef.current?.view) return
    const view = viewRef.current.view
    const sel = view.state.selection.main
    if (sel.empty) return
    event.preventDefault()
    setBubbleOpen(false)
    setContextMenu({ top: event.clientY, left: event.clientX, from: sel.from, to: sel.to })
  }, [contextMenuEnabled, viewRef])

  return {
    bubbleOpen,
    bubblePos,
    selectionRange,
    contextMenu,
    setContextMenu,
    applySelectionRange,
    openBubble,
    closeBubble,
    handleContextMenu,
  }
}
