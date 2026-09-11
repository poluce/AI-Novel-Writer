import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import type { RendererActionSink } from '../renderer-action'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

const Schema = Type.Object({
  workflow: Type.String(),
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

export function createStartWorkflowTool(
  language: WritingLanguage,
  rendererAction: RendererActionSink,
): AgentTool<typeof Schema> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'Start an AI Novel Writer creative workflow for drafting, review, refinement, finalization, blueprint generation, or architecture generation.'
    : '触发 AI小说作家创作工作流。支持写稿、修稿、审稿、定稿、生成蓝图等工作流。这将在 AI 输出面板中执行对应的多步骤创作流程。'

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

      const chapterWorkflows = ['generate_draft', 'review', 'refine', 'finalize']
      if (chapterWorkflows.includes(workflow) && chapterNumber === undefined) {
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

      rendererAction({
        type: 'start_workflow',
        workflow,
        ...(chapterNumber === undefined ? {} : { chapterNumber }),
      })

      return {
        content: [{ type: 'text', text: text(
          `已启动「${displayName}${chapterInfo}」工作流。`,
          `Started the ${displayName}${chapterInfo} workflow.`,
        ) }],
        details: {},
      }
    },
  }
}
