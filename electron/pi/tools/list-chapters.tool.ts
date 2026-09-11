import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { BlueprintRepository } from '../../repositories/blueprint-repository'
import { DraftRepository } from '../../repositories/draft-repository'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

export interface ListChaptersDetails {
  total: number
  blueprints: number
  drafts: number
  finalized: number
}

const EmptySchema = Type.Object({})

/**
 * list_chapters — 列出所有章节状态概览（主进程直连仓库）。
 *
 * 这是内置工具从渲染进程迁到主进程的样板：TypeBox schema + 直接调
 * repository（不再经 ipc.invoke）+ `{content, details}` 返回、失败 throw。
 */
export function createListChaptersTool(
  language: WritingLanguage,
): AgentTool<typeof EmptySchema, ListChaptersDetails> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'List every chapter and whether it has a blueprint, draft, or finalized manuscript to summarize overall project progress.'
    : '列出项目中所有章节的状态概览，包括哪些章节有蓝图、有草稿、已定稿等信息。用于了解项目整体进度。'

  return {
    name: 'list_chapters',
    label: 'List Chapters',
    description,
    parameters: EmptySchema,
    execute: async () => {
      const blueprints = BlueprintRepository.getAll()
      const drafts = DraftRepository.listAll()

      const bpNums = new Set(blueprints.map((bp) => bp.chapterNumber))
      const draftNums = new Set(drafts.map((d) => d.chapterNumber))
      const finalizedNums = new Set(
        drafts.filter((d) => d.status === 'finalized').map((d) => d.chapterNumber),
      )

      const allNums = new Set([...bpNums, ...draftNums, ...finalizedNums])
      if (allNums.size === 0) {
        return {
          content: [{ type: 'text', text: text(
            '📊 项目中暂无任何章节数据。建议先生成故事架构和章节蓝图。',
            '📊 This project has no chapter data yet. Generate the story architecture and chapter blueprints first.',
          ) }],
          details: { total: 0, blueprints: 0, drafts: 0, finalized: 0 },
        }
      }

      const sortedNums = Array.from(allNums).sort((a, b) => a - b)
      const rows = sortedNums.map((num) => {
        const hasBp = bpNums.has(num) ? '✅' : '❌'
        const hasDraft = draftNums.has(num) ? '✅' : '❌'
        const hasMs = finalizedNums.has(num) ? '✅' : '❌'
        return `| ${num} | ${hasBp} | ${hasDraft} | ${hasMs} |`
      })
      const header = text(
        '| 章节 | 蓝图 | 草稿 | 定稿 |',
        '| Chapter | Blueprint | Draft | Finalized |',
      )
      const table = `${header}\n| --- | --- | --- | --- |\n${rows.join('\n')}`
      const summary = text(
        `📊 章节进度概览\n\n${table}\n\n总计：${sortedNums.length} 个章节，${bpNums.size} 个蓝图，${draftNums.size} 个草稿，${finalizedNums.size} 个定稿`,
        `📊 Chapter progress\n\n${table}\n\nTotal: ${sortedNums.length} chapters, ${bpNums.size} blueprints, ${draftNums.size} drafts, ${finalizedNums.size} finalized`,
      )

      return {
        content: [{ type: 'text', text: summary }],
        details: {
          total: sortedNums.length,
          blueprints: bpNums.size,
          drafts: draftNums.size,
          finalized: finalizedNums.size,
        },
      }
    },
  }
}
