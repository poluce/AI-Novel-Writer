import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { BlueprintRepository } from '../../repositories/blueprint-repository'
import { buildChapterBlueprintProposal } from '../../../src/shared/domain-proposals'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

const Schema = Type.Object({
  chapter_number: Type.Number(),
  changes: Type.Record(Type.String(), Type.Unknown()),
})

export function createProposeChapterBlueprintTool(
  language: WritingLanguage,
): AgentTool<typeof Schema, { chapterNumber: number; fields: number }> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'Propose field changes to an existing chapter blueprint. The app shows the current and proposed values and writes only after user approval.'
    : '提出一个现有章节蓝图的字段变更。应用会读取目标蓝图并展示当前值与建议值，必须由用户批准后才写入。'

  return {
    name: 'propose_chapter_blueprint',
    label: 'Propose Chapter Blueprint',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const chapterNumber = params.chapter_number
      if (!Number.isInteger(chapterNumber) || chapterNumber <= 0) {
        throw new Error(text('章节号无效', 'The chapter number is invalid'))
      }

      const current = BlueprintRepository.getByChapter(chapterNumber)
      if (!current) {
        throw new Error(text(`第 ${chapterNumber} 章蓝图不存在`, `The blueprint for Chapter ${chapterNumber} does not exist`))
      }

      // 与确认卡片共用同一份字段白名单与规范化逻辑。
      const proposal = buildChapterBlueprintProposal(
        params as Record<string, unknown>,
        current,
        text,
      )
      if (!proposal.valid) throw new Error(proposal.error)
      const changes = proposal.changes as Record<string, unknown>

      BlueprintRepository.upsert({ ...current, ...changes } as Parameters<typeof BlueprintRepository.upsert>[0])

      return {
        content: [{ type: 'text', text: text(
          `第 ${chapterNumber} 章蓝图已更新（${Object.keys(changes).length} 个字段）`,
          `Chapter ${chapterNumber} blueprint updated (${Object.keys(changes).length} fields)`,
        ) }],
        details: { chapterNumber, fields: Object.keys(changes).length },
      }
    },
  }
}
