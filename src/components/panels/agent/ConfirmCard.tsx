/**
 * ConfirmCard — 操作确认卡片
 *
 * 当 Agent 调用需要确认的 Tool 时显示此卡片。
 * 用户可以批准或拒绝操作。
 */
import { useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import type { ToolCallInfo } from '../../../shared/agent-ui-types'
import { useAgentStore } from '../../../stores/agent-store'
import { useLocaleStore } from '../../../stores/locale-store'
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
  const impactReady = impactPreview.kind === 'none' || impactPreview.kind === 'valid'
  const canApprove = (!isDomainProposal || proposalPreview.kind === 'valid') && impactReady

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
        {!isDomainProposal && Object.keys(args).length > 0 && (
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
    case 'write_file':
      return text(
        `将写入文件：${args.file_path ?? '未知路径'}`,
        `Will write file: ${args.file_path ?? 'Unknown path'}`,
      )
    case 'open_editor':
      return text(
        `将在编辑器中打开：${args.file_path ?? '未知文件'}`,
        `Will open in the editor: ${args.file_path ?? 'Unknown file'}`,
      )
    case 'start_workflow':
      return text(
        `将启动工作流：${args.workflow ?? '未知工作流'}${args.chapter_number ? `（第 ${args.chapter_number} 章）` : ''}`,
        `Will start workflow: ${args.workflow ?? 'Unknown workflow'}${args.chapter_number ? ` (Chapter ${args.chapter_number})` : ''}`,
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
      const oldText = String(args.old_text ?? '')
      const newText = String(args.new_text ?? '')
      return text(
        `将替换第 ${args.chapter_number ?? '？'} 章草稿中的一段原文：\n「${preview(oldText)}」\n→「${preview(newText)}」`,
        `Will replace one excerpt in chapter ${args.chapter_number ?? '?'} :\n"${preview(oldText)}"\n→ "${preview(newText)}"`,
      )
    }
    case 'propose_novel_config':
      return text('小说配置变更提案', 'Novel configuration change proposal')
    case 'propose_chapter_blueprint':
      return text(
        `第 ${args.chapter_number ?? '？'} 章蓝图变更提案`,
        `Chapter ${args.chapter_number ?? '?'} blueprint change proposal`,
      )
    default:
      return text(`将执行操作：${toolName}`, `Will run operation: ${toolName}`)
  }
}
