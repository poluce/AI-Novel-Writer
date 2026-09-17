/**
 * 草稿行内差异对比与修订装饰器 (Inline Draft Diff & Track-Changes Revisions)
 *
 * 为 CodeMirror 6 提供类似代码 diff / 审阅修订的行内实时展示：
 * - 将被替换/删除的原文（oldText）：显示为红色背景 + 删除线 (.cm-diff-deletion)
 * - 提议替换/新增的新文（newText）：以 Widget 形式显示为绿色背景 (.cm-diff-insertion)
 * - 行内操作按钮：提供 [合并] 与 [放弃] 按钮，点击直接批准或拒绝该修改提案
 */
import { WidgetType, Decoration, type DecorationSet } from '@codemirror/view'

export interface DraftDiffProposal {
  id: string
  chapterNumber?: number
  draftId?: number
  oldText: string
  newText: string
  status: 'pending' | 'accepted' | 'rejected'
  onAccept?: () => void | Promise<void>
  onReject?: () => void | Promise<void>
}

/**
 * CodeMirror 6 行内差异插入 Widget
 * 渲染绿色新增正文及 [合并] [放弃] 按钮
 */
export class DiffInsertionWidget extends WidgetType {
  constructor(
    readonly proposal: DraftDiffProposal,
    readonly locale: 'zh-CN' | 'en-US' = 'zh-CN',
  ) {
    super()
  }

  eq(other: DiffInsertionWidget): boolean {
    return (
      this.proposal.id === other.proposal.id &&
      this.proposal.newText === other.proposal.newText &&
      this.proposal.oldText === other.proposal.oldText &&
      this.proposal.status === other.proposal.status &&
      this.locale === other.locale
    )
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-diff-widget-wrap'
    wrap.dataset.diffId = this.proposal.id

    // 1. 新增正文（绿色高亮显示）
    if (this.proposal.newText) {
      const ins = document.createElement('span')
      ins.className = 'cm-diff-insertion'
      ins.textContent = this.proposal.newText
      wrap.appendChild(ins)
    }

    // 2. 行内操作按钮群（合并 / 放弃）
    const actions = document.createElement('span')
    actions.className = 'cm-diff-actions'

    const acceptBtn = document.createElement('button')
    acceptBtn.type = 'button'
    acceptBtn.className = 'cm-diff-btn cm-diff-btn-accept'
    acceptBtn.title = this.locale === 'zh-CN' ? '合并/应用此修改' : 'Accept this revision'
    acceptBtn.textContent = this.locale === 'zh-CN' ? '合并' : 'Accept'
    acceptBtn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    acceptBtn.onclick = (e) => {
      e.preventDefault()
      e.stopPropagation()
      void this.proposal.onAccept?.()
    }
    actions.appendChild(acceptBtn)

    const rejectBtn = document.createElement('button')
    rejectBtn.type = 'button'
    rejectBtn.className = 'cm-diff-btn cm-diff-btn-reject'
    rejectBtn.title = this.locale === 'zh-CN' ? '放弃/拒绝此修改' : 'Reject this revision'
    rejectBtn.textContent = this.locale === 'zh-CN' ? '放弃' : 'Reject'
    rejectBtn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    rejectBtn.onclick = (e) => {
      e.preventDefault()
      e.stopPropagation()
      void this.proposal.onReject?.()
    }
    actions.appendChild(rejectBtn)

    wrap.appendChild(actions)
    return wrap
  }

  ignoreEvent(): boolean {
    // 允许 Widget 内的按钮点击事件由 DOM 自身处理，不被 CodeMirror 劫持为光标选区事件
    return true
  }
}

/**
 * 根据待确认的草稿修改提案构建 CodeMirror 装饰集
 */
export function buildDiffDecorations(
  proposals: readonly DraftDiffProposal[] | undefined,
  docText: string,
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
): DecorationSet {
  if (!proposals || proposals.length === 0 || !docText) {
    return Decoration.none
  }

  type DecoItem = { from: number; to: number; deco: Decoration }
  const items: DecoItem[] = []

  for (const proposal of proposals) {
    if (proposal.status !== 'pending' || !proposal.oldText) continue

    const index = docText.indexOf(proposal.oldText)
    if (index === -1) continue

    const from = index
    const to = index + proposal.oldText.length

    // 1. 红色删除线装饰原正文
    items.push({
      from,
      to,
      deco: Decoration.mark({ class: 'cm-diff-deletion' }),
    })

    // 2. 紧跟在其后的绿色新增正文及操作 Widget
    items.push({
      from: to,
      to,
      deco: Decoration.widget({
        widget: new DiffInsertionWidget(proposal, locale),
        side: 1,
      }),
    })
  }

  if (items.length === 0) {
    return Decoration.none
  }

  // CodeMirror 要求装饰按起始位置排序
  items.sort((a, b) => a.from - b.from || a.to - b.to)

  return Decoration.set(
    items.map(item => item.deco.range(item.from, item.to)),
    true,
  )
}
