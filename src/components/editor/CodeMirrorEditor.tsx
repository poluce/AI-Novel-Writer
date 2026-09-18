import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import CodeMirror, { ReactCodeMirrorRef, EditorView, ViewUpdate } from '@uiw/react-codemirror'
import { keymap } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { EditorState } from '@codemirror/state'
import { openSearchPanel, closeSearchPanel, search } from '@codemirror/search'
import { Sparkles, Bold, Pencil, MessageSquarePlus } from 'lucide-react'
import { cn } from '../../lib/utils'
import { countDraftUnits } from '../../shared/draft-units'
import { useLocaleStore } from '../../stores/locale-store'
import { useAgentStore } from '../../stores/agent-store'
import { useLayoutStore } from '../../stores/layout-store'
import {
  MAX_DRAFT_ANNOTATIONS,
  MAX_DRAFT_ANNOTATION_NOTE,
  type DraftAnnotation,
} from '../../shared/draft-annotation'
import { type DraftPassageCitation } from '../../shared/draft-excerpt'
import { type DraftDiffProposal, buildDiffDecorations } from './draft-diff'
import { annotationDecorations, useDraftAnnotations } from './use-draft-annotations'
import { useDraftDiffDecorations } from './use-draft-diff-decorations'
import { useEditorBubble } from './use-editor-bubble'
import { useEditorAiHandoff } from './use-editor-ai-handoff'

export type CodeMirrorEditorProps = {
  content: string
  filePath?: string
  editable?: boolean
  onChange?: (content: string) => void
  onSave?: (content: string) => Promise<void> | void
  onCharCountChange?: (count: number) => void
  placeholder?: string
  hideStatusBar?: boolean
  mode?: 'document' | 'prose'
  enableAnnotations?: boolean
  annotations?: readonly DraftAnnotation[]
  onAnnotationsChange?: (annotations: DraftAnnotation[]) => void
  diffProposals?: readonly DraftDiffProposal[]
  scrollToDiffRequestId?: number
  showLineNumbers?: boolean
  chapterNumber?: number
  draftId?: number
  draftVersion?: number
  onAddToAssistant?: (citation: DraftPassageCitation) => void
}

export default function CodeMirrorEditor({
  content,
  editable = true,
  onChange,
  onSave,
  onCharCountChange,
  placeholder,
  mode = 'document',
  enableAnnotations = false,
  annotations = [],
  onAnnotationsChange,
  diffProposals = [],
  scrollToDiffRequestId,
  showLineNumbers = false,
  chapterNumber,
  draftId,
  draftVersion,
  filePath,
  onAddToAssistant,
}: CodeMirrorEditorProps) {
  const uiText = useLocaleStore(s => s.text)
  const uiLocale = useLocaleStore(s => s.locale)
  const editorRef = useRef<ReactCodeMirrorRef>(null)

  // 避免状态回路
  const lastEmittedContentRef = useRef(content)
  const [editorContent, setEditorContent] = useState(content)
  const hasEmittedInitialCount = useRef(false)

  // 更新内容
  useEffect(() => {
    // 首次挂载时主动汇报一次字数
    if (!hasEmittedInitialCount.current) {
      onCharCountChange?.(countDraftUnits(content))
      hasEmittedInitialCount.current = true
    }

    if (content !== lastEmittedContentRef.current) {
      lastEmittedContentRef.current = content
      setEditorContent(content)
      // 内容经由外部变动（例如打开新文件）
      onCharCountChange?.(countDraftUnits(content))
    }
  }, [content, onCharCountChange])

  // ===== 浮动条（Bubble Menu）=====
  // 选区变化要清掉半路输入的批注草稿，而批注 hook 又需要浮动条持有的选区——
  // 用一个稳定的回调 + ref 打通，避免两个 hook 的调用顺序形成环。接缝留在这里。
  const clearAnnotationDraftRef = useRef<() => void>(() => {})
  const handleSelectionChange = useCallback(() => { clearAnnotationDraftRef.current() }, [])
  const {
    bubbleOpen,
    bubblePos,
    selectionRange,
    contextMenu,
    setContextMenu,
    openBubble,
    closeBubble,
    handleContextMenu,
  } = useEditorBubble({
    viewRef: editorRef,
    onSelectionChange: handleSelectionChange,
    contextMenuEnabled: Boolean(onAddToAssistant),
  })

  // 行内修订（draft diff）的装饰与视口联动
  const { compartment: diffCompartment } = useDraftDiffDecorations({
    viewRef: editorRef,
    proposals: diffProposals,
    content: editorContent,
    locale: uiLocale,
    scrollToRequestId: scrollToDiffRequestId,
  })

  // 草稿批注：装饰、区间重映射与落库
  const {
    compartment: annotationCompartment,
    note: annotationNote,
    setNote: setAnnotationNote,
    inputFocusedRef: annotationInputFocusedRef,
    clearDraft: clearAnnotationDraft,
    remapOnDocChange: remapAnnotationsOnDocChange,
    addAnnotation,
  } = useDraftAnnotations({
    viewRef: editorRef,
    annotations,
    enabled: Boolean(enableAnnotations),
    onChange: onAnnotationsChange,
    selectionRange,
  })

  // 把批注层"清草稿"的能力交给浮动条层：选区一变就丢掉上一个选区的草稿。
  // 用 effect 登记（渲染期写 ref 会被 react-hooks/refs 拦下）；clearAnnotationDraft
  // 自身是稳定引用，所以这里实际只在挂载后跑一次。
  useEffect(() => {
    clearAnnotationDraftRef.current = clearAnnotationDraft
  }, [clearAnnotationDraft])

  const handleUpdate = useCallback((v: ViewUpdate) => {
    if (v.docChanged) {
      const newText = v.state.doc.toString()
      lastEmittedContentRef.current = newText
      onChange?.(newText)

      const cnt = countDraftUnits(newText)
      onCharCountChange?.(cnt)
      remapAnnotationsOnDocChange(v)
    }

    if (v.selectionSet || v.docChanged || v.geometryChanged) {
      const sel = v.state.selection.main
      if (sel.empty || sel.to - sel.from < 1) {
        if (annotationInputFocusedRef.current) return
        closeBubble()
      } else {
        // 交由浮动条自己的 effect 进行精准防越界座标计算与位置同步
        openBubble({ from: sel.from, to: sel.to })
      }
    }
  }, [onChange, onCharCountChange, remapAnnotationsOnDocChange, openBubble, closeBubble, annotationInputFocusedRef])

  // 主题配置
  const cmTheme = useMemo(() => EditorView.theme({
    "&": {
      height: "100%",
      // prose/document 都是写作场景，使用写作字体
      // 其他模式（如代码等）继承父元素 UI 字体
      fontSize: mode === 'prose' ? "16px" : "14px",
      backgroundColor: "transparent",
      fontFamily: (mode === 'prose' || mode === 'document') ? "var(--font-writing)" : "inherit"
    },
    ".cm-scroller": {
      overflow: "auto",
      paddingBottom: "100px",
      cursor: "text",
      fontFamily: (mode === 'prose' || mode === 'document') ? "var(--font-writing)" : "inherit"
    },
    ".cm-content": {
      width: "100%",
      maxWidth: "800px",
      margin: "0 auto",
      padding: "40px",
      lineHeight: "1.8",
      color: "var(--color-text)",
      cursor: "text",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor": { borderLeftColor: "var(--color-editor-caret, var(--color-text))", borderLeftWidth: "2px" },
    ".cm-activeLine": { backgroundColor: "transparent" },
    ".cm-selectionBackground, .cm-focused .cm-selectionBackground": { backgroundColor: "var(--color-hover) !important" },
    ".cm-line": { padding: "0" },
    ".cm-draft-annotation": {
      backgroundColor: "color-mix(in srgb, var(--color-warning, #d97706) 22%, transparent)",
      borderBottom: "1px dashed var(--color-warning-text, #b45309)",
    },
    ".cm-diff-deletion": {
      backgroundColor: "color-mix(in srgb, var(--color-error, #ef4444) 18%, transparent) !important",
      color: "var(--color-error-text, #dc2626) !important",
      textDecoration: "line-through !important",
      textDecorationColor: "var(--color-error, #ef4444) !important",
      textDecorationThickness: "1.5px !important",
      borderRadius: "2px",
      padding: "1px 2px",
    },
    ".cm-diff-widget-wrap": {
      display: "inline",
      verticalAlign: "baseline",
    },
    ".cm-diff-insertion": {
      backgroundColor: "color-mix(in srgb, var(--color-success, #22c55e) 18%, transparent) !important",
      color: "var(--color-success-text, #16a34a) !important",
      borderBottom: "2px solid var(--color-success, #22c55e) !important",
      borderRadius: "2px",
      padding: "1px 3px",
      marginLeft: "3px",
      marginRight: "4px",
      whiteSpace: "pre-wrap",
      fontFamily: "inherit",
      fontWeight: "normal",
    },
    ".cm-diff-actions": {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      marginLeft: "4px",
      marginRight: "6px",
      verticalAlign: "middle",
      userSelect: "none",
    },
    ".cm-diff-btn": {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      gap: "2px",
      padding: "1px 6px",
      fontSize: "11px",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      fontWeight: "500",
      borderRadius: "4px",
      cursor: "pointer",
      lineHeight: "1.4",
      transition: "all 0.15s ease",
      boxShadow: "0 1px 2px rgba(0, 0, 0, 0.08)",
    },
    ".cm-diff-btn:active": {
      transform: "scale(0.96)",
    },
    ".cm-diff-btn-accept": {
      backgroundColor: "var(--color-success, #22c55e)",
      color: "var(--color-success-foreground, #ffffff)",
      border: "1px solid var(--color-success, #22c55e)",
    },
    ".cm-diff-btn-accept:hover": {
      filter: "brightness(1.1)",
      boxShadow: "0 1px 4px color-mix(in srgb, var(--color-success) 40%, transparent)",
    },
    ".cm-diff-btn-reject": {
      backgroundColor: "color-mix(in srgb, var(--color-error, #ef4444) 15%, transparent)",
      color: "var(--color-error-text, #dc2626)",
      border: "1px solid color-mix(in srgb, var(--color-error, #ef4444) 30%, transparent)",
    },
    ".cm-diff-btn-reject:hover": {
      backgroundColor: "var(--color-error, #ef4444)",
      color: "var(--color-error-foreground, #ffffff)",
      borderColor: "var(--color-error, #ef4444)",
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      border: "none",
      color: "var(--color-text-muted)",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      minWidth: "2.2em",
      padding: "0 8px 0 0",
      fontSize: "12px",
    },
  }), [mode])

  // 构建扩展
  const extensions = useMemo(() => {
    const exts = [
      search({ top: true }),
      EditorView.lineWrapping,
      keymap.of([
        {
          key: 'Tab',
          run: (target) => {
            if (target.state.readOnly) return false
            // 插入两个 em 空格（U+2003）= 2em = 标准中文首行缩进两字符宽
            // 使用 \u2003 而非 \u3000（全角空格），因为 em 空格在任何 Unicode 字体下
            // 都精确等于 1em，不依赖 CJK 字体加载
            target.dispatch({
              changes: { from: target.state.selection.main.head, insert: '\u2003\u2003' },
              selection: { anchor: target.state.selection.main.head + 2 }
            })
            return true
          }
        }
      ]),
      // 汉化 Search / UI 文本（涵盖官方大小写所有变种）
      EditorState.phrases.of(uiLocale === 'zh-CN' ? {
        "Find": "查找",
        "find": "查找",
        "Replace": "替换",
        "replace": "替换",
        "Replace all": "全部替换",
        "replace all": "全部替换",
        "Next": "下一个",
        "next": "下一个",
        "Previous": "上一个",
        "previous": "上一个",
        "All": "全部选中",
        "all": "全部选中",
        "Match case": "区分大小写",
        "match case": "区分大小写",
        "Regexp": "正则表达式",
        "regexp": "正则表达式",
        "by word": "全词匹配",
        "By word": "全词匹配",
        "Close": "关闭",
        "close": "关闭"
      } : {})
    ]
    if (mode === 'document') {
      exts.push(markdown({ base: markdownLanguage, codeLanguages: languages }))
    }
    // 批注装饰的初值必须随 extensions 一起给：CodeMirror 的 view 由子组件稍后创建，
    // 父组件 effect 第一次跑的时候还不一定有 view。之后的变化由下面的 reconfigure
    // 单独写入，不重建整个 extensions 数组。
    exts.push(annotationCompartment.of(EditorView.decorations.of(annotationDecorations(annotations))))
    // 行内差异对比装饰初值
    exts.push(diffCompartment.of(EditorView.decorations.of(buildDiffDecorations(diffProposals, content, uiLocale))))
    return exts
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 批注/差异刻意不进依赖：进了就会因批注/差异变化重建 extensions（等于重置编辑器）；变化走 reconfigure。
  }, [annotationCompartment, diffCompartment, mode, uiLocale])

  // 批注落库交给 useDraftAnnotations；这里只做界面收尾（关浮动条、清选区）。
  const handleAddAnnotation = () => {
    if (!addAnnotation()) return
    closeBubble()
  }

  // 选区 → 助手：引用构造与提示词在 useEditorAiHandoff，store 接线留在这里（组合点）。
  const dispatchPrompt = useCallback((citation: DraftPassageCitation, prompt: string) => {
    useAgentStore.getState().addComposerCitation(citation)
    useLayoutStore.getState().openRightPanel('agent')
    void useAgentStore.getState().sendMessage(prompt)
  }, [])
  const closeContextMenu = useCallback(() => setContextMenu(null), [setContextMenu])
  const { aiActions, runAIAction, addSelectionToAssistant } = useEditorAiHandoff({
    viewRef: editorRef,
    selectionRange,
    uiText,
    chapterNumber,
    draftId,
    draftVersion,
    filePath,
    onDispatchPrompt: dispatchPrompt,
    onAddCitation: onAddToAssistant,
    closeBubble,
    closeContextMenu,
  })

  // 固定 basicSetup 内存引用，防止 React 每次渲染生成新对象导致内部扩展被重载（搜索框消失的罪魁祸首）
  const cmBasicSetup = useMemo(() => ({
    lineNumbers: showLineNumbers,
    foldGutter: false,
    dropCursor: false,
    allowMultipleSelections: false,
    indentOnInput: false,
    highlightActiveLine: false,
    highlightActiveLineGutter: false,
    searchKeymap: true,
  }), [showLineNumbers])

  return (
    <div className="relative h-full flex flex-col min-h-0"
      onKeyDownCapture={(e) => {
        // 全局捕获 Ctrl+F 实现搜索框 Toggle（解决搜索框内焦点时快捷键失效的问题）
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
          e.preventDefault()
          e.stopPropagation()
          const view = editorRef.current?.view
          if (view) {
            const searchPanel = view.dom.querySelector('.cm-search')
            if (searchPanel) {
              closeSearchPanel(view)
              view.focus()
            } else {
              openSearchPanel(view)
            }
          }
        }
      }}
      onKeyDown={(e) => {
        // 捕获 Cmd+S 保存
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
          e.preventDefault()
          onSave?.(lastEmittedContentRef.current)
        }
      }}>
      <div className="flex-1 relative min-h-0 overflow-hidden"
        onContextMenu={handleContextMenu}>
        <div className="absolute inset-0">
          <CodeMirror
            ref={editorRef}
            value={editorContent}
            placeholder={placeholder}
            height="100%"
            className="h-full"
            theme={cmTheme}
            extensions={extensions}
            readOnly={!editable}
            editable={editable}
            basicSetup={cmBasicSetup}
            onUpdate={handleUpdate}
          />
        </div>
        {contextMenu && onAddToAssistant && createPortal(
          <div
            className="fixed z-[80] py-1 rounded-md shadow-xl min-w-[168px]"
            style={{
              top: contextMenu.top,
              left: contextMenu.left,
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
                addSelectionToAssistant(contextMenu.from, contextMenu.to)
              }}
            >
              {uiText('添加到助手', 'Add to assistant')}
            </button>
          </div>,
          document.body,
        )}
      </div>

      {/* Bubble Menu */}
      {bubbleOpen && editable && bubblePos.top !== 0 && (
        <div
          className="fixed z-50 flex items-center gap-0.5 p-1 rounded-xl border select-none shadow-xl transform -translate-x-1/2 -translate-y-full"
          style={{
            top: bubblePos.top,
            left: bubblePos.left,
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
          {enableAnnotations && mode === 'prose' && (
            <div className="flex items-center gap-1 pr-1">
              <Pencil size={11} style={{ color: 'var(--color-warning-text, #b45309)' }} />
              <input
                value={annotationNote}
                maxLength={MAX_DRAFT_ANNOTATION_NOTE}
                onChange={event => setAnnotationNote(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    handleAddAnnotation()
                  }
                }}
                onFocus={() => { annotationInputFocusedRef.current = true }}
                onBlur={() => { annotationInputFocusedRef.current = false }}
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
                disabled={!annotationNote.trim() || annotations.length >= MAX_DRAFT_ANNOTATIONS}
                onClick={handleAddAnnotation}
              >{uiText('标注', 'Note')}</button>
              <div className="w-[1px] h-3 mx-1" style={{ backgroundColor: 'var(--color-border)' }} />
            </div>
          )}
          {mode === 'document' && (
            <>
              <button
                className="p-1 rounded"
                style={{ color: 'var(--color-text-secondary)' }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--color-hover)')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                onClick={() => {
                  // document模式下的格式转换
                  if (selectionRange && editorRef.current?.view) {
                    const view = editorRef.current.view
                    const text = view.state.sliceDoc(selectionRange.from, selectionRange.to)
                    view.dispatch({
                      changes: { from: selectionRange.from, to: selectionRange.to, insert: `**${text}**` }
                    })
                  }
                }}
              ><Bold size={14} /></button>
              <div className="w-[1px] h-3 mx-1" style={{ backgroundColor: 'var(--color-border)' }} />
            </>
          )}
          {onAddToAssistant && selectionRange && (
            <>
              <button
                className="p-1.5 rounded flex items-center gap-1 text-[10px]"
                style={{ color: 'var(--color-accent)' }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--color-hover)')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                onClick={() => addSelectionToAssistant(selectionRange.from, selectionRange.to)}
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
              onClick={() => runAIAction(action)}
            >
              <span className="text-[10px] tracking-widest">{uiText(...action.label)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
