import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { BlueprintRepository } from '../../repositories/blueprint-repository'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

const STRING_FIELDS = new Set([
  'title', 'role', 'purpose', 'keyEvents', 'suspenseHook', 'userGuidance', 'notes',
])
const FIELD_ALIASES: Record<string, string> = {
  '作者微操指导': 'userGuidance',
  '用户指引': 'userGuidance',
}

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

      const candidate = params.changes
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || Object.keys(candidate).length === 0) {
        throw new Error(text('缺少章节蓝图变更字段', 'No chapter blueprint changes were provided'))
      }

      const changes: Record<string, unknown> = {}
      for (const [field, proposed] of Object.entries(candidate)) {
        const canonicalField = FIELD_ALIASES[field] ?? field
        if (STRING_FIELDS.has(canonicalField)) {
          if (typeof proposed !== 'string') throw new Error(text(`字段 ${field} 必须是文本`, `Field ${field} must be text`))
        } else if (canonicalField === 'characters') {
          if (!Array.isArray(proposed) || !proposed.every((item) => typeof item === 'string')) {
            throw new Error(text('字段 characters 必须是文本数组', 'Field characters must be an array of text values'))
          }
        } else {
          throw new Error(text(`未知章节蓝图字段：${field}`, `Unknown chapter blueprint field: ${field}`))
        }
        changes[canonicalField] = proposed
      }

      const current = BlueprintRepository.getByChapter(chapterNumber)
      if (!current) {
        throw new Error(text(`第 ${chapterNumber} 章蓝图不存在`, `The blueprint for Chapter ${chapterNumber} does not exist`))
      }

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
