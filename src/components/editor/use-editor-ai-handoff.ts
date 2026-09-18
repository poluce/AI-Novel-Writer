/**
 * 选区 → 助手的派发：四个 AI 动作与右键"添加到助手"。
 *
 * 从 CodeMirrorEditor 抽出来的业务层。它只做两件事：把选区包成 `DraftPassageCitation`，
 * 以及把动作对应的提示词取出来；**真正写进助手会话的动作由调用方提供**
 * （`onDispatchPrompt` / `onAddCitation`）——store 接线留在组件里当组合点，
 * 这一层因此可以脱离 store 单独测试。
 *
 * 背景：编辑器的 AI 动作已统一为"带选区引用的 Agent Quick Task"（见
 * `docs/plans/2026-09-18-legacy-communication-layer-artifacts.md` §6.4），
 * 编辑器不再自己申领模型租约、也不再自己拼生成链路。
 */
import { useCallback, type RefObject } from 'react'
import type { ReactCodeMirrorRef } from '@uiw/react-codemirror'
import type { EditorView } from '@codemirror/view'
import type { GenerationReasoningStage } from '../../shared/reasoning-types'
import { MAX_DRAFT_EXCERPT_CHARS, type DraftPassageCitation } from '../../shared/draft-excerpt'

export type EditorAIAction = {
  key: 'refine' | 'expand' | 'continue' | 'dialogue'
  label: readonly [string, string]
  color: string
  prompt: readonly [string, string]
  reasoningStage: GenerationReasoningStage
}

export const AI_ACTIONS = [
  { key: 'refine', label: ['润色', 'Refine'], color: 'text-[var(--color-category-progress-text)]', prompt: ['润色这部分，使语言自然、具体并增强场景表现力。', 'Refine this passage for natural, specific language and stronger scene craft.'], reasoningStage: 'review' },
  { key: 'expand', label: ['扩写', 'Expand'], color: 'text-[var(--color-warning-text)]', prompt: ['扩写这部分，补充与情节有关的动作、感官和环境细节。', 'Expand this passage with plot-relevant action, sensory detail, and setting.'], reasoningStage: 'drafting' },
  { key: 'continue', label: ['续写', 'Continue'], color: 'text-[var(--color-category-review-text)]', prompt: ['根据现有因果和人物动机，自然续写接下来的情节。', 'Continue naturally from the established causality and character motivation.'], reasoningStage: 'drafting' },
  { key: 'dialogue', label: ['对话', 'Dialogue'], color: 'text-[var(--color-success-text)]', prompt: ['将这部分改写为有区分度、能推动冲突的自然对话。', 'Rewrite this passage as distinct, natural dialogue that advances the conflict.'], reasoningStage: 'drafting' },
] satisfies readonly EditorAIAction[]

export function useEditorAiHandoff({
  viewRef,
  selectionRange,
  uiText,
  chapterNumber,
  draftId,
  draftVersion,
  filePath,
  onDispatchPrompt,
  onAddCitation,
  closeBubble,
  closeContextMenu,
}: {
  viewRef: RefObject<ReactCodeMirrorRef | null>
  selectionRange: { from: number; to: number } | null
  uiText: (zh: string, en: string) => string
  chapterNumber?: number
  draftId?: number
  draftVersion?: number
  filePath?: string
  /** 把"引用 + 提示词"送进助手会话（由组件接 store）。 */
  onDispatchPrompt: (citation: DraftPassageCitation, prompt: string) => void
  /** 右键"添加到助手"的目标；没有这个入口时整条右键路径不生效。 */
  onAddCitation?: (citation: DraftPassageCitation) => void
  closeBubble: () => void
  closeContextMenu: () => void
}) {
  const buildCitation = useCallback((view: EditorView, from: number, to: number): DraftPassageCitation => {
    const quote = view.state.sliceDoc(from, to)
    const fromLine = view.state.doc.lineAt(from).number
    const toLine = view.state.doc.lineAt(Math.max(to - 1, from)).number
    return {
      id: crypto.randomUUID(),
      chapterNumber,
      draftId,
      version: draftVersion,
      fromLine,
      toLine,
      quote: quote.slice(0, MAX_DRAFT_EXCERPT_CHARS),
    }
  }, [chapterNumber, draftId, draftVersion])

  /** 浮动条上的四个动作：统一作为带选区引用的 Quick Task 派发。 */
  const runAIAction = useCallback((action: EditorAIAction) => {
    const view = viewRef.current?.view
    if (!selectionRange || !view) return
    const selectedText = view.state.sliceDoc(selectionRange.from, selectionRange.to)
    if (!selectedText.trim()) return

    onDispatchPrompt(
      buildCitation(view, selectionRange.from, selectionRange.to),
      uiText(...action.prompt),
    )
    closeBubble()
  }, [buildCitation, closeBubble, onDispatchPrompt, selectionRange, uiText, viewRef])

  /** 右键菜单：把这一段作为引用加入助手输入框。 */
  const addSelectionToAssistant = useCallback((from: number, to: number) => {
    const view = viewRef.current?.view
    if (!onAddCitation || !view) return
    const quote = view.state.sliceDoc(from, to)
    if (!quote.trim()) {
      closeContextMenu()
      return
    }
    onAddCitation({ ...buildCitation(view, from, to), filePath })
    closeContextMenu()
    closeBubble()
  }, [buildCitation, closeBubble, closeContextMenu, filePath, onAddCitation, viewRef])

  return { aiActions: AI_ACTIONS, runAIAction, addSelectionToAssistant }
}
