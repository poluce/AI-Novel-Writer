import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { DraftRepository } from '../../repositories/draft-repository'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

const DRAFT_TYPE_ALIASES: Record<string, 'draft_v1' | 'revised' | 'latest'> = {
  draft_v1: 'draft_v1',
  revised: 'revised',
  latest: 'latest',
  '初稿': 'draft_v1',
  '草稿': 'draft_v1',
  '修订稿': 'revised',
  '修订': 'revised',
  '最新稿': 'latest',
  '最新': 'latest',
}

const DraftType = Type.Union([
  Type.Literal('latest', { description: '当前最新版本正文草稿（默认）' }),
  Type.Literal('draft_v1', { description: '章节初稿（第 1 版正文草稿）' }),
  Type.Literal('revised', { description: '修订润色稿' }),
], { description: '读取的草稿版本：latest（最新稿，默认）、draft_v1（初稿）、revised（修订稿）' })

const Schema = Type.Object({
  chapter_number: Type.Integer({ minimum: 1, description: '要读取的章节序号（正整数，如 1）' }),
  draft_type: Type.Optional(DraftType),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: '从第几行开始读取（行号从 1 开始）' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: '单次读取的最大行数' })),
})

export function createReadDraftsTool(
  language: WritingLanguage,
): AgentTool<typeof Schema, { chapterNumber: number; version?: number; totalLines?: number; offset?: number; limit?: number }> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'Read a chapter draft, including its initial or revised versions, with optional line-level pagination.'
    : '读取指定章节的草稿内容。支持初稿、修订稿等版本，以及基于行数的分页读取。'

  return {
    name: 'read_drafts',
    label: 'Read Drafts',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const chapterNum = params.chapter_number
      const rawDraftType = params.draft_type ?? 'latest'
      const draftType = DRAFT_TYPE_ALIASES[rawDraftType] ?? 'latest'

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

      const allLines = fullDraft.content.split('\n')
      const totalLines = allLines.length
      const offset = Math.max(1, params.offset ?? 1)
      const limit = params.limit && params.limit > 0 ? params.limit : totalLines
      const startIndex = offset - 1
      const selectedLines = allLines.slice(startIndex, startIndex + limit)
      const isPaged = offset > 1 || limit < totalLines
      const pagedContent = selectedLines.join('\n')

      const header = text(
        `📝 第 ${chapterNum} 章草稿（${targetName}）${isPaged ? ` [第 ${offset}–${Math.min(startIndex + limit, totalLines)} 行 / 共 ${totalLines} 行]` : ''}`,
        `📝 Chapter ${chapterNum} draft (${targetName})${isPaged ? ` [Lines ${offset}-${Math.min(startIndex + limit, totalLines)} of ${totalLines}]` : ''}`,
      )

      return {
        content: [{ type: 'text', text: `${header}\n\n${pagedContent}` }],
        details: {
          chapterNumber: chapterNum,
          version: fullDraft.version,
          totalLines,
          offset,
          limit,
        },
      }
    },
  }
}
