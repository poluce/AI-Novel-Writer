import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { BlueprintRepository } from '../../repositories/blueprint-repository'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

const Schema = Type.Object({
  chapter_number: Type.Number(),
})

export function createReadBlueprintTool(
  language: WritingLanguage,
): AgentTool<typeof Schema, { chapterNumber: number }> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'Read one chapter blueprint: its plot, scene allocation, planned character appearances, suspense hook, and author guidance. For the blueprint list or chapter progress use read_project_state.'
    : '读取某一章的蓝图：剧情、场景分配、出场角色、悬念钩子与作者指导。要蓝图清单或章节进度请用 read_project_state。'

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
        throw new Error(text(
          `第 ${chapterNumber} 章蓝图不存在或读取失败`,
          `The blueprint for Chapter ${chapterNumber} does not exist or could not be read`,
        ))
      }
      return {
        content: [{ type: 'text', text: text(
          `📋 第 ${chapterNumber} 章蓝图\n\n标题: ${bp.title}\n作用: ${bp.role}\n目的: ${bp.purpose}\n关键事件: ${bp.keyEvents}\n角色: ${bp.characters.join(', ')}\n悬念: ${bp.suspenseHook}\n备注: ${bp.notes}\n用户指引: ${bp.userGuidance}`,
          `📋 Chapter ${chapterNumber} blueprint\n\nTitle: ${bp.title}\nRole: ${bp.role}\nPurpose: ${bp.purpose}\nKey events: ${bp.keyEvents}\nCharacters: ${bp.characters.join(', ')}\nSuspense hook: ${bp.suspenseHook}\nNotes: ${bp.notes}\nUser guidance: ${bp.userGuidance}`,
        ) }],
        details: { chapterNumber },
      }
    },
  }
}
