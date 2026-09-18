/**
 * 编辑器主题与 basicSetup：纯配置，无状态。
 *
 * 从 CodeMirrorEditor 搬出来的引擎配置层——这里只描述"编辑器长什么样"，
 * 不持有任何状态，因此可以脱离 React 单独断言。
 * 颜色一律走语义 token（--color-*），皮肤切换由 token 层负责，这里不做皮肤分支。
 */
import { EditorView } from "@codemirror/view"

export type EditorMode = 'document' | 'prose'

/** 写作场景用写作字体；其他模式（代码等）继承父元素 UI 字体。 */
export function buildEditorTheme(mode: EditorMode) {
  return EditorView.theme({
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
  })
}

/**
 * basicSetup 的选项。保持同一份内存引用由调用方负责（useMemo），
 * 否则每次渲染生成新对象会导致内部扩展被重载——搜索框会因此消失。
 */
export function buildEditorBasicSetup(showLineNumbers: boolean) {
  return {
    lineNumbers: showLineNumbers,
    foldGutter: false,
    dropCursor: false,
    allowMultipleSelections: false,
    indentOnInput: false,
    highlightActiveLine: false,
    highlightActiveLineGutter: false,
    searchKeymap: true,
  }
}
