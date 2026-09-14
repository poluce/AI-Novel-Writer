import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { ProjectCoreRepository } from '../../repositories/project-core-repository'
import type { RendererActionSink } from '../renderer-action'
import {
  buildNovelConfigProposal,
  type ProposalText,
} from '../../../src/shared/domain-proposals'
import type { NovelConfig } from '../../../src/shared/ipc-channels'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

const Schema = Type.Object({
  changes: Type.Record(Type.String(), Type.Unknown()),
  blueprint_changes: Type.Optional(Type.Array(Type.Unknown())),
})

export function createProposeNovelConfigTool(
  language: WritingLanguage,
  rendererAction: RendererActionSink,
): AgentTool<typeof Schema, { fields: number }> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'Propose changes to the novel configuration. The app shows a diff and impact preview, then writes only after user approval.'
    : '提出小说配置字段变更。应用会展示当前值、建议值与一次性影响预览，必须由用户批准后才写入。'

  return {
    name: 'propose_novel_config',
    label: 'Propose Novel Config',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      // 与确认卡片共用同一份字段白名单与规范化逻辑。
      const core = ProjectCoreRepository.get()
      const current = {
        ...(core ?? {}),
        narrativePOV: core?.narrativePov,
      } as unknown as NovelConfig
      const proposal = buildNovelConfigProposal(
        params as Record<string, unknown>,
        current,
        text as ProposalText,
      )
      if (!proposal.valid) throw new Error(proposal.error)
      const changes = proposal.changes as Record<string, unknown>

      const { narrativePOV, ...rest } = changes
      ProjectCoreRepository.update({
        ...rest,
        ...(narrativePOV !== undefined ? { narrativePov: narrativePOV as string } : {}),
      } as Parameters<typeof ProjectCoreRepository.update>[0])

      rendererAction({ type: 'refresh_project_config' })

      return {
        content: [{ type: 'text', text: text(
          `小说配置已更新（${Object.keys(changes).length} 个字段）`,
          `Novel configuration updated (${Object.keys(changes).length} fields)`,
        ) }],
        details: { fields: Object.keys(changes).length },
      }
    },
  }
}
