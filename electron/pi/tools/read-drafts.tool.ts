import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { DraftRepository } from '../../repositories/draft-repository'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

const DraftType = Type.Union([
  Type.Literal('draft_v1'),
  Type.Literal('revised'),
  Type.Literal('latest'),
])

const Schema = Type.Object({
  chapter_number: Type.Number(),
  draft_type: Type.Optional(DraftType),
})

export function createReadDraftsTool(
  language: WritingLanguage,
): AgentTool<typeof Schema, { chapterNumber: number; version?: number }> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'Read a chapter draft, including its initial or revised versions.'
    : '读取指定章节的草稿内容。可以获取初稿、修订稿等不同版本。'

  return {
    name: 'read_drafts',
    label: 'Read Drafts',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const chapterNum = params.chapter_number
      const draftType = params.draft_type ?? 'latest'

      const drafts = DraftRepository.listByChapter(chapterNum)
      if (drafts.length === 0) {
        return {
          content: [{ type: 'text', text: text(
            `第 ${chapterNum} 章暂无草稿。`,
            `Chapter ${chapterNum} has no drafts yet.`,
          ) }],
          details: { chapterNumber: chapterNum },
        }
      }

      let targetId: number | null = null
      let targetName = ''
      if (draftType === 'latest') {
        const latest = drafts[0]
        targetId = latest.id
        targetName = `v${latest.version}`
      } else {
        const target = drafts.find((d) => {
          if (draftType === 'draft_v1') return d.version === 1
          if (draftType === 'revised') return d.version > 1
          return false
        })
        if (!target) {
          const available = drafts.map((d) => `v${d.version}`).join(', ')
          throw new Error(text(
            `未找到 "${draftType}" 类型的草稿。可用版本：${available}`,
            `No "${draftType}" draft was found. Available versions: ${available}`,
          ))
        }
        targetId = target.id
        targetName = `v${target.version}`
      }

      const fullDraft = DraftRepository.getFull(targetId)
      if (!fullDraft) {
        throw new Error(text(
          `读取草稿内容失败：id ${targetId}`,
          `Could not read draft content: id ${targetId}`,
        ))
      }

      return {
        content: [{ type: 'text', text: text(
          `📝 第 ${chapterNum} 章草稿（${targetName}）\n\n${fullDraft.content}`,
          `📝 Chapter ${chapterNum} draft (${targetName})\n\n${fullDraft.content}`,
        ) }],
        details: { chapterNumber: chapterNum, version: fullDraft.version },
      }
    },
  }
}
