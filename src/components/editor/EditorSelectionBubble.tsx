/**
 * 编辑器浮动条与选区右键菜单：受控展示组件。
 *
 * 从 CodeMirrorEditor 抽出来的视图层——这里只负责"长什么样、点了什么"，
 * 不持有状态、也不碰编辑器实例：所有动作（加粗、加引用、跑 AI 动作）都由上层
 * 以回调传入。好处是测浮动条不必渲染整个 CodeMirror。
 *
 * 注意两处刻意保留的细节：
 * 1. 浮动条容器在非输入框区域 `preventDefault()`，避免点击按钮时选区被浏览器清掉；
 *    输入框内只 `stopPropagation()`，否则输入框无法获得焦点。
 * 2. 右键菜单用 `onMouseDown` 而非 `onClick`：菜单挂在 body 上，窗口级 mousedown
 *    会先关掉它，用 click 会来不及触发。
 */
import { createPortal } from 'react-dom'
import { Sparkles, Bold, Pencil, MessageSquarePlus } from 'lucide-react'
import { cn } from '../../lib/utils'
import { MAX_DRAFT_ANNOTATIONS, MAX_DRAFT_ANNOTATION_NOTE } from '../../shared/draft-annotation'
import type { EditorAIAction } from './use-editor-ai-handoff'

export interface EditorSelectionBubbleProps {
  open: boolean
  position: { top: number; left: number }
  uiText: (zh: string, en: string) => string
  /** 批注区（prose 模式且开启批注时显示）。 */
  annotationVisible: boolean
  annotationNote: string
  annotationCount: number
  onAnnotationNoteChange: (value: string) => void
  onAnnotationInputFocusChange: (focused: boolean) => void
  onAddAnnotation: () => void
  /** 加粗（document 模式）。 */
  boldVisible: boolean
  onBold: () => void
  /** "添加到助手"。 */
  addToAssistantVisible: boolean
  onAddToAssistant: () => void
  /** 四个 AI 动作。 */
  aiActions: readonly EditorAIAction[]
  onRunAIAction: (action: EditorAIAction) => void
}

export function EditorSelectionBubble({
  open,
  position,
  uiText,
  annotationVisible,
  annotationNote,
  annotationCount,
  onAnnotationNoteChange,
  onAnnotationInputFocusChange,
  onAddAnnotation,
  boldVisible,
  onBold,
  addToAssistantVisible,
  onAddToAssistant,
  aiActions,
  onRunAIAction,
}: EditorSelectionBubbleProps) {
  if (!open || position.top === 0) return null

  return (
    <div
      className="fixed z-50 flex items-center gap-0.5 p-1 rounded-xl border select-none shadow-xl transform -translate-x-1/2 -translate-y-full"
      style={{
        top: position.top,
        left: position.left,
        backgroundColor: 'var(--color-sidebar)',
        borderColor: 'var(--color-border)',
      }}
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('input, textarea')) {
          e.stopPropagation()
          return
        }
        e.preventDefault()
      }}
    >
      {annotationVisible && (
        <div className="flex items-center gap-1 pr-1">
          <Pencil size={11} style={{ color: 'var(--color-warning-text, #b45309)' }} />
          <input
            value={annotationNote}
            maxLength={MAX_DRAFT_ANNOTATION_NOTE}
            onChange={event => onAnnotationNoteChange(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                onAddAnnotation()
              }
            }}
            onFocus={() => onAnnotationInputFocusChange(true)}
            onBlur={() => onAnnotationInputFocusChange(false)}
            placeholder={uiText('这段有什么问题？', 'What is wrong with this passage?')}
            className="w-[180px] px-1.5 py-1 text-[11px] rounded-md"
            style={{
              background: 'var(--color-bg-elevated, var(--color-panel))',
              border: '1px solid var(--color-border)',
              color: 'var(--color-text)',
              outline: 'none',
            }}
            aria-label={uiText('选区标注', 'Passage note')}
          />
          <button
            className="px-1.5 py-1 text-[10px] rounded-md font-medium"
            style={{
              backgroundColor: annotationNote.trim() ? 'var(--color-accent)' : 'var(--color-hover)',
              color: annotationNote.trim() ? '#fff' : 'var(--color-text-muted)',
            }}
            disabled={!annotationNote.trim() || annotationCount >= MAX_DRAFT_ANNOTATIONS}
            onClick={onAddAnnotation}
          >{uiText('标注', 'Note')}</button>
          <div className="w-[1px] h-3 mx-1" style={{ backgroundColor: 'var(--color-border)' }} />
        </div>
      )}
      {boldVisible && (
        <>
          <button
            className="p-1 rounded"
            style={{ color: 'var(--color-text-secondary)' }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--color-hover)')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
            onClick={onBold}
          ><Bold size={14} /></button>
          <div className="w-[1px] h-3 mx-1" style={{ backgroundColor: 'var(--color-border)' }} />
        </>
      )}
      {addToAssistantVisible && (
        <>
          <button
            className="p-1.5 rounded flex items-center gap-1 text-[10px]"
            style={{ color: 'var(--color-accent)' }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--color-hover)')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
            onClick={onAddToAssistant}
          >
            <MessageSquarePlus size={11} />
            {uiText('添加到助手', 'Add to assistant')}
          </button>
          <div className="w-[1px] h-3 mx-1" style={{ backgroundColor: 'var(--color-border)' }} />
        </>
      )}
      <div
        className="flex items-center gap-0.5 pl-0.5 pr-1 text-[10px]"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <Sparkles size={11} />AI
      </div>
      {aiActions.map(action => (
        <button
          key={action.key}
          className={cn('p-1.5 rounded flex items-center gap-1 transition-colors', action.color)}
          onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--color-hover)')}
          onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
          onClick={() => onRunAIAction(action)}
        >
          <span className="text-[10px] tracking-widest">{uiText(...action.label)}</span>
        </button>
      ))}
    </div>
  )
}

export interface EditorContextMenuProps {
  position: { top: number; left: number }
  label: string
  onSelect: () => void
}

/** 选区右键菜单：挂在 body 上，靠窗口级 mousedown 关闭（见文件头注释 2）。 */
export function EditorContextMenu({ position, label, onSelect }: EditorContextMenuProps) {
  return createPortal(
    <div
      className="fixed z-[80] py-1 rounded-md shadow-xl min-w-[168px]"
      style={{
        top: position.top,
        left: position.left,
        backgroundColor: 'var(--color-sidebar)',
        border: '1px solid var(--color-border)',
      }}
      onMouseDown={event => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <button
        type="button"
        className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--color-hover)]"
        onMouseDown={event => {
          event.preventDefault()
          event.stopPropagation()
          onSelect()
        }}
      >
        {label}
      </button>
    </div>,
    document.body,
  )
}
