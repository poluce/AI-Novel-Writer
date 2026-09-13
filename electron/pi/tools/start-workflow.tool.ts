import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import type { RendererActionSink } from '../renderer-action'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

const WorkflowName = Type.Union([
  Type.Literal('generate_draft'),
  Type.Literal('review'),
  Type.Literal('refine'),
  Type.Literal('finalize'),
  Type.Literal('generate_blueprint'),
  Type.Literal('generate_architecture'),
])

const Schema = Type.Object({
  workflow: WorkflowName,
  chapter_number: Type.Optional(Type.Number()),
})

const WORKFLOW_NAMES: Record<string, readonly [string, string]> = {
  generate_draft: ['写稿', 'draft'],
  review: ['审稿', 'review'],
  refine: ['修稿', 'refinement'],
  finalize: ['定稿', 'finalization'],
  generate_blueprint: ['生成蓝图', 'blueprint generation'],
  generate_architecture: ['生成架构', 'architecture generation'],
}

const CHAPTER_WORKFLOWS = ['generate_draft', 'review', 'refine', 'finalize'] as const

export function createStartWorkflowTool(
  language: WritingLanguage,
  rendererAction: RendererActionSink,
): AgentTool<typeof Schema> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'Start an AI Novel Writer creative workflow for drafting, review, refinement, finalization, blueprint generation, or architecture generation. Only report success after the task panel has registered the run. Review, refinement, and finalization require an open draft in the editor and will fail if started with only a chapter number.'
    : '触发 AI小说作家创作工作流。支持写稿、修稿、审稿、定稿、生成蓝图、生成架构。必须等任务中心真正注册成功后才能报告成功。审稿、修稿、定稿需要已打开的草稿，仅凭章节号会失败。'

  return {
    name: 'start_workflow',
    label: 'Start Workflow',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const workflow = params.workflow
      if (!workflow) {
        throw new Error(text('缺少 workflow 参数', 'The workflow argument is required'))
      }
      const chapterNumber = params.chapter_number

      if ((CHAPTER_WORKFLOWS as readonly string[]).includes(workflow) && chapterNumber === undefined) {
        throw new Error(text(
          `${workflow} 工作流需要指定 chapter_number 参数`,
          `The ${workflow} workflow requires a chapter_number argument`,
        ))
      }

      const workflowName = WORKFLOW_NAMES[workflow]
      const displayName = workflowName ? text(...workflowName) : workflow
      const chapterInfo = chapterNumber !== undefined
        ? text(`（第 ${chapterNumber} 章）`, ` (Chapter ${chapterNumber})`)
        : ''

      const outcome = await rendererAction({
        type: 'start_workflow',
        workflow,
        ...(chapterNumber === undefined ? {} : { chapterNumber }),
      })
      if (!outcome) {
        throw new Error(text(
          `「${displayName}${chapterInfo}」工作流未能注册到任务中心，未向模型报告成功。`,
          `The ${displayName}${chapterInfo} workflow was not registered in the task panel.`,
        ))
      }
      if (!outcome.ok) {
        throw new Error(outcome.error)
      }

      return {
        content: [{ type: 'text', text: outcome.summary }],
        details: {},
      }
    },
  }
}
