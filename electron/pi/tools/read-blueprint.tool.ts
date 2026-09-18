import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { BlueprintRepository } from '../../repositories/blueprint-repository'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

const Schema = Type.Object({
  chapter_number: Type.Number({
    description: '目标章节号（正整数，如 1）。',
  }),
})

export function createReadBlueprintTool(
  language: WritingLanguage,
): AgentTool<typeof Schema, { chapterNumber: number }> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'Read one chapter blueprint: its plot, scene allocation, planned character appearances, suspense hook, and author guidance.'
    : '读取某一章的细纲蓝图：剧情、场景分配、出场角色、悬念钩子与作者指导。若该章尚未规划，将友好返回提示信息。'

  return {
    name: 'read_blueprint',
    label: 'Read Blueprint',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const chapterNumber = params.chapter_number
      if (!Number.isInteger(chapterNumber) || chapterNumber <= 0) {
        throw new Error(text('章节号无效', 'The chapter number is invalid'))
      }

      const bp = BlueprintRepository.getByChapter(chapterNumber)
      if (!bp) {
        return {
          content: [{ type: 'text', text: text(
            `第 ${chapterNumber} 章蓝图目前尚未创建。你可以直接构思并使用 propose_chapter_blueprint 工具为该章创建细纲。`,
            `The blueprint for Chapter ${chapterNumber} has not been created yet. You can design and create it directly using propose_chapter_blueprint.`,
          ) }],
          details: { chapterNumber },
        }
      }

      return {
        content: [{ type: 'text', text: text(
          `第 ${chapterNumber} 章蓝图\n\n标题: ${bp.title || '（未定）'}\n作用: ${bp.role}\n目的: ${bp.purpose || '（未定）'}\n关键事件: ${bp.keyEvents || '（未定）'}\n角色: ${bp.characters && bp.characters.length > 0 ? bp.characters.join('、') : '无'}\n悬念: ${bp.suspenseHook || '无'}\n备注: ${bp.notes || '无'}\n用户指引: ${bp.userGuidance || '无'}`,
          `Chapter ${chapterNumber} blueprint\n\nTitle: ${bp.title}\nRole: ${bp.role}\nPurpose: ${bp.purpose}\nKey events: ${bp.keyEvents}\nCharacters: ${bp.characters ? bp.characters.join(', ') : ''}\nSuspense hook: ${bp.suspenseHook}\nNotes: ${bp.notes}\nUser guidance: ${bp.userGuidance}`,
        ) }],
        details: { chapterNumber },
      }
    },
  }
}
