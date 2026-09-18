/**
 * 编辑器扩展集的构建：引擎配置层，纯函数、无状态。
 *
 * 集中三件事：基础扩展（搜索、换行、Tab 缩进）、界面语言（搜索面板词条、
 * document 模式下的 markdown 语言支持），以及两个特性 compartment 的**初值**挂载。
 *
 * 为什么初值要在这里给：CodeMirror 的 view 由 React 子组件稍后创建，父组件 effect
 * 第一次跑的时候还不一定有 view；之后的变化由各自的 reconfigure 单独写入，
 * 不重建整个 extensions 数组（重建等于重置编辑器）。
 */
import { EditorState, type Compartment, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { search } from '@codemirror/search'
import type { Locale } from '../../i18n/types'
import type { DraftAnnotation } from '../../shared/draft-annotation'
import { annotationDecorations } from './draft-annotations'
import { type DraftDiffProposal, buildDiffDecorations } from './draft-diff'
import { buildSearchPhrases } from './editor-search-phrases'
import type { EditorMode } from './editor-theme'

export function buildEditorExtensions({
  mode,
  locale,
  annotationCompartment,
  diffCompartment,
  annotations,
  diffProposals,
  content,
}: {
  mode: EditorMode
  locale: Locale
  annotationCompartment: Compartment
  diffCompartment: Compartment
  /** 批注/差异只用于给装饰**初值**；后续变化走 reconfigure，不进本函数的依赖。 */
  annotations: readonly DraftAnnotation[]
  diffProposals?: readonly DraftDiffProposal[]
  content: string
}): Extension[] {
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
    EditorState.phrases.of(buildSearchPhrases(locale)),
  ]
  if (mode === 'document') {
    exts.push(markdown({ base: markdownLanguage, codeLanguages: languages }))
  }
  // 批注装饰的初值必须随 extensions 一起给：CodeMirror 的 view 由子组件稍后创建，
  // 父组件 effect 第一次跑的时候还不一定有 view。之后的变化由下面的 reconfigure
  // 单独写入，不重建整个 extensions 数组。
  exts.push(annotationCompartment.of(EditorView.decorations.of(annotationDecorations(annotations))))
  // 行内差异对比装饰初值
  exts.push(diffCompartment.of(EditorView.decorations.of(buildDiffDecorations(diffProposals, content, locale))))
  return exts
}
