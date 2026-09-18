/**
 * ConfirmCard — 操作确认卡片
 *
 * 当 Agent 调用需要确认的 Tool 时显示此卡片。
 * 用户可以批准或拒绝操作。
 */
import { useState } from 'react'
import { ShieldAlert, ExternalLink } from 'lucide-react'
import type { ToolCallInfo } from '../../../shared/agent-ui-types'
import { useAgentStore } from '../../../stores/agent-store'
import { useEditorStore } from '../../../stores/editor-store'
import { useProjectStore } from '../../../stores/project-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { projectSessionContextFromProject } from '../../../shared/project-session-context'
import { ipc } from '../../../services/ipc-client'
import { openChapterFile } from '../sidebar/sidebar-file-openers'
import ConfigImpactPreview, { useConfigImpactPreview } from './ConfigImpactPreview'
import DomainProposalDiff, { useDomainProposalPreview } from './DomainProposalDiff'

interface Props {
  toolCall: ToolCallInfo
}

export default function ConfirmCard({ toolCall }: Props) {
  const { resolveToolConfirmation, cancelGeneration } = useAgentStore()
  const text = useLocaleStore(s => s.text)
  const { id, toolName, arguments: args } = toolCall
  const proposalPreview = useDomainProposalPreview(toolCall)
  const impactPreview = useConfigImpactPreview(toolCall, proposalPreview)
  const [selectedImpactKeys, setSelectedImpactKeys] = useState<Set<string>>(() => new Set())
  const isDomainProposal = proposalPreview.kind !== 'none'
  const canApprove = proposalPreview.kind !== 'stale'

  const handleViewInDraft = async () => {
    const chapterNumber = typeof args.chapter_number === 'number'
      ? args.chapter_number
      : parseInt(String(args.chapter_number ?? ''), 10)
    if (!Number.isInteger(chapterNumber) || chapterNumber < 1) return

    const currentProject = useProjectStore.getState().currentProject
    if (!currentProject) return

    // 1. 检查当前是否已打开该章节草稿 Tab
    const existingTab = useEditorStore.getState().tabs.find(
      t => t.chapterNumber === chapterNumber && t.type === 'chapter' && t.projectKey === currentProject.path,
    )
    if (existingTab) {
      useEditorStore.getState().setActiveTab(existingTab.id)
      return
    }

    // 2. 否则从数据库读取最新草稿并打开
    const session = projectSessionContextFromProject(currentProject)
    if (!session) return

    const latest = await ipc.invokeWithProjectSession(session, 'db:draft-get-latest', chapterNumber, currentProject.path)
    if (latest && typeof latest === 'object' && 'id' in latest) {
      const draftId = Number((latest as { id: number }).id)
      await openChapterFile(`vela://draft/${draftId}`, `第 ${chapterNumber} 章`)
    }
  }

  // 生成操作描述
  const description = generateDescription(toolName, args, text)

  return (
    <div className="confirm-card">
      {/* 头部 */}
      <div className="confirm-card-header">
        <ShieldAlert size={14} />
        <span>{text('需要确认操作', 'Confirmation required')}</span>
      </div>

      {/* 内容 */}
      <div className="confirm-card-body">
        <div>{description}</div>
        <DomainProposalDiff toolCall={toolCall} preview={proposalPreview} />
        <ConfigImpactPreview
          preview={impactPreview}
          selectedKeys={selectedImpactKeys}
          onSelectionChange={(key, selected) => setSelectedImpactKeys(current => {
            const next = new Set(current)
            if (selected) next.add(key)
            else next.delete(key)
            return next
          })}
        />
        {/* 草稿局部修改专属红绿对比与跳转按钮 */}
        {toolName === 'replace_draft_excerpt' && (
          <div className="mt-2 space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-[var(--color-text-secondary)] font-medium">
                {text(`第 ${args.chapter_number ?? '？'} 章草稿修改对比`, `Chapter ${args.chapter_number ?? '?'} draft diff`)}
              </span>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-[11px] text-[var(--color-accent)] hover:underline cursor-pointer"
                onClick={() => void handleViewInDraft()}
                title={text('在主编辑器中打开并定位到该处对比', 'Open in main editor and jump to this diff')}
              >
                <ExternalLink size={11} />
                {text('在草稿中查看行内对比', 'View inline diff in draft')}
              </button>
            </div>
            <div className="p-2 rounded border border-red-500/30 bg-red-500/10 text-[var(--color-error-text)]">
              <div className="text-[10px] font-semibold mb-0.5">
                {text('将被替换的原文：', 'Original excerpt (to be removed):')}
              </div>
              <div className="line-through whitespace-pre-wrap select-text font-serif">
                {String(args.old_text ?? '')}
              </div>
            </div>
            <div className="p-2 rounded border border-green-500/30 bg-green-500/10 text-[var(--color-success-text)]">
              <div className="text-[10px] font-semibold mb-0.5">
                {text('替换后的新文：', 'New excerpt (to be inserted):')}
              </div>
              <div className="whitespace-pre-wrap select-text font-serif">
                {String(args.new_text ?? '')}
              </div>
            </div>
          </div>
        )}
        {!isDomainProposal && toolName !== 'replace_draft_excerpt' && Object.keys(args).length > 0 && (
          <div
            style={{
              marginTop: 6,
              padding: '4px 8px',
              borderRadius: 4,
              backgroundColor: 'var(--color-hover)',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.68rem',
              color: 'var(--color-text-secondary)',
              whiteSpace: 'pre-wrap',
              maxHeight: 120,
              overflowY: 'auto',
            }}
          >
            {JSON.stringify(args, null, 2)}
          </div>
        )}
      </div>

      {/* 操作按钮 */}
      <div className="confirm-card-actions">
        {isDomainProposal && (
          <button
            className="confirm-card-btn reject"
            onClick={() => void cancelGeneration()}
          >
            {text('取消本次助手任务', 'Cancel this Agent task')}
          </button>
        )}
        <button
          className="confirm-card-btn reject"
          onClick={() => resolveToolConfirmation(id, false)}
        >
          {text('拒绝', 'Reject')}
        </button>
        <button
          className="confirm-card-btn approve"
          disabled={!canApprove}
          onClick={() => {
            const blueprintProposals = impactPreview.kind === 'valid'
              ? impactPreview.blueprintProposals
                  .filter(proposal => selectedImpactKeys.has(proposal.key))
                  .map(proposal => ({ name: proposal.name, arguments: proposal.arguments }))
              : []
            if (blueprintProposals.length > 0) {
              resolveToolConfirmation(id, true, { blueprintProposals })
              return
            }
            resolveToolConfirmation(id, true)
          }}
        >
          {text('批准执行', 'Approve')}
        </button>
      </div>
    </div>
  )
}

/** 长文本预览：确认卡要让人一眼看清将要发生什么，而不是把整段正文塞进来。 */
function preview(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** 根据 Tool 名称生成人类可读的操作描述 */
function generateDescription(
  toolName: string,
  args: Record<string, unknown>,
  text: ReturnType<typeof useLocaleStore.getState>['text'],
): string {
  switch (toolName) {
    case 'open_editor':
      return text(
        `将在编辑器中打开：${args.file_path ?? '未知文件'}`,
        `Will open in the editor: ${args.file_path ?? 'Unknown file'}`,
      )
    case 'bash':
      // Pi harness 的执行工具：命令原文必须出现在确认卡上。
      return text(
        `将执行命令：\n${preview(String(args.command ?? ''), 300)}`,
        `Will run command:\n${preview(String(args.command ?? ''), 300)}`,
      )
    case 'write':
      return text(
        `将写入文件：${args.path ?? '未知路径'}（${String(args.content ?? '').length} 字符）`,
        `Will write file: ${args.path ?? 'Unknown path'} (${String(args.content ?? '').length} chars)`,
      )
    case 'edit': {
      const edits = Array.isArray(args.edits) ? args.edits as Array<Record<string, unknown>> : []
      const first = edits[0] ?? {}
      return text(
        `将修改文件：${args.path ?? '未知路径'}（${edits.length} 处）\n「${preview(String(first.oldText ?? ''))}」\n→「${preview(String(first.newText ?? ''))}」`,
        `Will edit file: ${args.path ?? 'Unknown path'} (${edits.length} change(s))\n"${preview(String(first.oldText ?? ''))}"\n→ "${preview(String(first.newText ?? ''))}"`,
      )
    }
    case 'install_writing_skill':
      return text(
        `将安装写作技能：${args.source_url ?? '未知来源'}`,
        `Will install writing skill: ${args.source_url ?? 'Unknown source'}`,
      )
    case 'bind_writing_skill':
      return text(
        `将把技能绑定到工作流阶段：${args.skill_id ?? '未知技能'} → ${args.stage ?? '未知阶段'}`,
        `Will bind a skill to a workflow stage: ${args.skill_id ?? 'Unknown skill'} → ${args.stage ?? 'Unknown stage'}`,
      )
    case 'replace_draft_excerpt': {
      return text(
        `将替换第 ${args.chapter_number ?? '？'} 章草稿中的一段原文`,
        `Will replace one excerpt in chapter ${args.chapter_number ?? '?'} draft`,
      )
    }
    case 'novel_config':
      return text('小说配置修改', 'Novel configuration update')
    case 'story_architecture': {
      const section = String(args.section ?? '故事架构')
      return text(
        `将填充/更新故事架构【${section}】`,
        `Will update story architecture [${section}]`,
      )
    }
    case 'propose_chapter_blueprint':
      return text(
        `第 ${args.chapter_number ?? '？'} 章蓝图变更提案`,
        `Chapter ${args.chapter_number ?? '?'} blueprint change proposal`,
      )
    default:
      return text(`将执行操作：${toolName}`, `Will run operation: ${toolName}`)
  }
}
