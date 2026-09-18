/* eslint-disable react-refresh/only-export-components */
import { useEffect, useMemo, useState } from 'react'

import type { ToolCallInfo } from '../../../shared/agent-ui-types'
import { ipc } from '../../../services/ipc-client'
import {
  buildChapterBlueprintProposal,
  buildNovelConfigProposal,
  type ProposalFieldDiff,
} from '../../../shared/domain-proposals'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { projectSessionContextFromProject, proposalBelongsToOpenProject } from '../../../shared/project-session-context'

export const CONFIG_LABELS: Record<string, readonly [string, string]> = {
  genre: ['类型', 'Genre'], subGenre: ['子类型', 'Subgenre'], targetAudience: ['目标读者', 'Target audience'],
  totalChapters: ['总章节数', 'Total chapters'], wordsPerChapter: ['每章字数', 'Words per chapter'],
  plotStructure: ['情节结构', 'Plot structure'], narrativePOV: ['叙事视角', 'Narrative POV'],
  coreOutline: ['核心大纲', 'Core outline'], worldSetting: ['世界设定', 'World setting'],
  goldenFinger: ['金手指', 'Special advantage'], protagonistProfile: ['主角设定', 'Protagonist profile'],
  globalGuidance: ['全局指导', 'Global guidance'], writingStyle: ['写作风格', 'Writing style'],
  referenceWorks: ['参考作品', 'Reference works'], writingLanguage: ['写作语言', 'Writing language'],
}
export const BLUEPRINT_LABELS: Record<string, readonly [string, string]> = {
  title: ['章节标题', 'Chapter title'], role: ['章节定位', 'Chapter role'], purpose: ['章节目的', 'Purpose'],
  keyEvents: ['关键事件', 'Key events'], characters: ['出场角色', 'Characters'], suspenseHook: ['悬念钩子', 'Suspense hook'],
  userGuidance: ['作者指导', 'Author guidance'], notes: ['备注', 'Notes'],
  batch_blueprints: ['批量章节', 'Batch chapters'],
}

export interface DomainProposalPreview {
  kind: 'none' | 'loading' | 'valid' | 'invalid' | 'stale'
  diffs: ProposalFieldDiff[]
  error?: string
  isNewCreation?: boolean
}

function displayValue(value: unknown, locale: string): string {
  if (Array.isArray(value)) return value.join(locale === 'zh-CN' ? '、' : ', ')
  if (value === undefined || value === null || value === '') return '—'
  return String(value)
}

export function useDomainProposalPreview(toolCall: ToolCallInfo): DomainProposalPreview {
  const currentProject = useProjectStore(s => s.currentProject)
  const text = useLocaleStore(s => s.text)
  const isConfig = toolCall.toolName === 'novel_config'
  const isBlueprint = toolCall.toolName === 'propose_chapter_blueprint'
  const sessionCurrent = proposalBelongsToOpenProject(toolCall.projectSession, currentProject)

  const [blueprintPreview, setBlueprintPreview] = useState<DomainProposalPreview>({ kind: 'loading', diffs: [] })

  const configPreview = useMemo<DomainProposalPreview>(() => {
    if (!isConfig) return { kind: 'none', diffs: [] }
    if (!currentProject || !sessionCurrent) return { kind: 'stale', diffs: [] }
    const proposal = buildNovelConfigProposal(toolCall.arguments, currentProject.novelConfig, text)
    return proposal.valid
      ? { kind: 'valid', diffs: proposal.diffs }
      : { kind: 'invalid', diffs: [], error: proposal.error }
  }, [currentProject, isConfig, sessionCurrent, text, toolCall.arguments])

  const blueprintImmediate = useMemo<DomainProposalPreview | null>(() => {
    if (!isBlueprint) return { kind: 'none', diffs: [] }
    if (!currentProject || !sessionCurrent) return { kind: 'stale', diffs: [] }

    // 支持批量蓝图预览
    if (Array.isArray(toolCall.arguments.blueprints) && toolCall.arguments.blueprints.length > 0) {
      const items = toolCall.arguments.blueprints as Array<{ chapter_number?: number; title?: string }>
      const chapterList = items.map(b => b.chapter_number).filter(Boolean).join(', ')
      return {
        kind: 'valid',
        isNewCreation: true,
        diffs: [{
          field: 'batch_blueprints',
          current: '（未规划）',
          proposed: text(`批量创建 ${items.length} 章节细纲（第 ${chapterList} 章）`, `Batch create ${items.length} blueprints (Chapters ${chapterList})`),
        }],
      }
    }

    const chapterNumber = toolCall.arguments.chapter_number
    if (chapterNumber === undefined || !Number.isInteger(chapterNumber) || (chapterNumber as number) <= 0) {
      return { kind: 'invalid', diffs: [], error: text('章节号无效，必须为正整数', 'Chapter number must be a positive integer') }
    }
    return null
  }, [currentProject, isBlueprint, sessionCurrent, text, toolCall.arguments])

  useEffect(() => {
    if (blueprintImmediate || !currentProject) return
    const liveSession = projectSessionContextFromProject(currentProject)
    if (!liveSession) return
    const chapterNumber = toolCall.arguments.chapter_number
    let disposed = false

    void ipc.invokeWithProjectSession(
      liveSession, 'db:blueprint-get', chapterNumber as number, currentProject.path,
    ).then((blueprint) => {
      if (disposed) return
      const now = useProjectStore.getState().currentProject
      if (!proposalBelongsToOpenProject(toolCall.projectSession, now)) {
        setBlueprintPreview({ kind: 'stale', diffs: [] })
        return
      }

      // 如果蓝图不存在，自动以新建模式构建提议，绝不报错
      const proposal = buildChapterBlueprintProposal(toolCall.arguments, blueprint, text)
      if (proposal.valid) {
        setBlueprintPreview({
          kind: 'valid',
          diffs: proposal.diffs,
          isNewCreation: proposal.isNewCreation,
        })
      } else {
        setBlueprintPreview({ kind: 'invalid', diffs: [], error: proposal.error })
      }
    }).catch(() => {
      // 查询失败时，仍作为新建蓝图处理，绝不阻塞用户批准
      const proposal = buildChapterBlueprintProposal(toolCall.arguments, null, text)
      if (!disposed) {
        setBlueprintPreview(proposal.valid
          ? { kind: 'valid', diffs: proposal.diffs, isNewCreation: true }
          : { kind: 'invalid', diffs: [], error: proposal.error })
      }
    })
    return () => { disposed = true }
  }, [blueprintImmediate, currentProject, text, toolCall.arguments, toolCall.projectSession])

  return isConfig ? configPreview : blueprintImmediate ?? blueprintPreview
}

export default function DomainProposalDiff({ toolCall, preview }: { toolCall: ToolCallInfo; preview: DomainProposalPreview }) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  if (preview.kind === 'none') return null
  if (preview.kind === 'loading') return <div className="text-xs opacity-70">{text('正在读取当前值…', 'Loading current values…')}</div>
  if (preview.kind === 'stale') return <div className="text-xs text-[var(--color-error-text)]">{text('项目已切换，此提案已过期，不会写入。', 'The project changed. This proposal is stale and will not be written.')}</div>
  if (preview.kind === 'invalid') return <div className="text-xs text-[var(--color-warning)]">{text(`参数提示：${preview.error ?? '未明确'}`, `Parameter notice: ${preview.error ?? 'Unspecified'}`)}</div>

  const labels = toolCall.toolName === 'novel_config' ? CONFIG_LABELS : BLUEPRINT_LABELS
  return (
    <div className="space-y-2" aria-label={text('字段变更', 'Field changes')}>
      {preview.isNewCreation && (
        <div className="text-xs text-[var(--color-accent)] font-medium">
          {text('（将创建全新章节细纲）', '(Will create new chapter blueprint)')}
        </div>
      )}
      {preview.diffs.map(diff => (
        <div key={diff.field} className="rounded border border-[var(--color-border)] p-2">
          <div className="mb-1 text-xs font-medium">{text(labels[diff.field]?.[0] ?? diff.field, labels[diff.field]?.[1] ?? diff.field)}</div>
          <div className="grid grid-cols-2 items-start gap-2 text-[0.7rem]">
            <div><span className="opacity-60">{text('当前', 'Current')}</span><div className="whitespace-pre-wrap break-words">{displayValue(diff.current, locale)}</div></div>
            <div><span className="opacity-60">{text('建议', 'Proposed')}</span><div className="whitespace-pre-wrap break-words">{displayValue(diff.proposed, locale)}</div></div>
          </div>
        </div>
      ))}
    </div>
  )
}
