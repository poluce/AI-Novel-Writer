import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import CodeMirror, { ReactCodeMirrorRef, ViewUpdate } from '@uiw/react-codemirror'
import { openSearchPanel, closeSearchPanel } from '@codemirror/search'
import { countDraftUnits } from '../../shared/draft-units'
import { useLocaleStore } from '../../stores/locale-store'
import { useAgentStore } from '../../stores/agent-store'
import { useLayoutStore } from '../../stores/layout-store'
import { type DraftAnnotation } from '../../shared/draft-annotation'
import { type DraftPassageCitation } from '../../shared/draft-excerpt'
import { type DraftDiffProposal } from './draft-diff'
import { useDraftAnnotations } from './use-draft-annotations'
import { useDraftDiffDecorations } from './use-draft-diff-decorations'
import { useEditorBubble } from './use-editor-bubble'
import { useEditorAiHandoff } from './use-editor-ai-handoff'
import { buildEditorBasicSetup, buildEditorTheme } from './editor-theme'
import { buildEditorExtensions } from './editor-extensions'
import { EditorContextMenu, EditorSelectionBubble } from './EditorSelectionBubble'

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
  const cmTheme = useMemo(() => buildEditorTheme(mode), [mode])

  // 构建扩展
  const extensions = useMemo(() => buildEditorExtensions({
    mode,
    locale: uiLocale,
    annotationCompartment,
    diffCompartment,
    annotations,
    diffProposals,
    content,
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 批注/差异刻意不进依赖：进了就会因批注/差异变化重建 extensions（等于重置编辑器）；变化走 reconfigure。
  }), [annotationCompartment, diffCompartment, mode, uiLocale])

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
  const cmBasicSetup = useMemo(() => buildEditorBasicSetup(showLineNumbers), [showLineNumbers])

  // document 模式下的格式转换：给选区套上 ** 强调标记。
  const handleBold = () => {
    if (!selectionRange || !editorRef.current?.view) return
    const view = editorRef.current.view
    const text = view.state.sliceDoc(selectionRange.from, selectionRange.to)
    view.dispatch({
      changes: { from: selectionRange.from, to: selectionRange.to, insert: `**${text}**` },
    })
  }

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
        {contextMenu && onAddToAssistant && (
          <EditorContextMenu
            position={contextMenu}
            label={uiText('添加到助手', 'Add to assistant')}
            onSelect={() => addSelectionToAssistant(contextMenu.from, contextMenu.to)}
          />
        )}
      </div>

      {/* Bubble Menu */}
      <EditorSelectionBubble
        open={bubbleOpen && editable}
        position={bubblePos}
        uiText={uiText}
        annotationVisible={Boolean(enableAnnotations && mode === 'prose')}
        annotationNote={annotationNote}
        annotationCount={annotations.length}
        onAnnotationNoteChange={setAnnotationNote}
        onAnnotationInputFocusChange={(focused: boolean) => { annotationInputFocusedRef.current = focused }}
        onAddAnnotation={handleAddAnnotation}
        boldVisible={mode === 'document'}
        onBold={handleBold}
        addToAssistantVisible={Boolean(onAddToAssistant && selectionRange)}
        onAddToAssistant={() => { if (selectionRange) addSelectionToAssistant(selectionRange.from, selectionRange.to) }}
        aiActions={aiActions}
        onRunAIAction={runAIAction}
      />
    </div>
  )
}
