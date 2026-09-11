import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { BlueprintRepository } from '../../repositories/blueprint-repository'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

const Schema = Type.Object({
  chapter_number: Type.Optional(Type.Number()),
})

export function createReadBlueprintTool(
  language: WritingLanguage,
): AgentTool<typeof Schema, { total?: number; chapterNumber?: number }> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'Read a chapter blueprint, including its plot, scene allocation, and planned character appearances.'
    : '读取指定章节的蓝图（剧情大纲、场景分配、角色出场计划等）。蓝图是写稿前的详细规划。'

  return {
    name: 'read_blueprint',
    label: 'Read Blueprint',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const chapterNum = params.chapter_number

      if (chapterNum !== undefined) {
        const bp = BlueprintRepository.getByChapter(chapterNum)
        if (!bp) {
          throw new Error(text(
            `第 ${chapterNum} 章蓝图不存在或读取失败`,
            `The blueprint for Chapter ${chapterNum} does not exist or could not be read`,
          ))
        }
        return {
          content: [{ type: 'text', text: text(
            `📋 第 ${chapterNum} 章蓝图\n\n标题: ${bp.title}\n作用: ${bp.role}\n目的: ${bp.purpose}\n关键事件: ${bp.keyEvents}\n角色: ${bp.characters.join(', ')}\n悬念: ${bp.suspenseHook}\n备注: ${bp.notes}\n用户指引: ${bp.userGuidance}`,
            `📋 Chapter ${chapterNum} blueprint\n\nTitle: ${bp.title}\nRole: ${bp.role}\nPurpose: ${bp.purpose}\nKey events: ${bp.keyEvents}\nCharacters: ${bp.characters.join(', ')}\nSuspense hook: ${bp.suspenseHook}\nNotes: ${bp.notes}\nUser guidance: ${bp.userGuidance}`,
          ) }],
          details: { chapterNumber: chapterNum },
        }
      }

      const bps = BlueprintRepository.getAll()
      if (bps.length === 0) {
        return {
          content: [{ type: 'text', text: text(
            '⚠️ 蓝图为空。建议先通过工作流生成章节蓝图。',
            '⚠️ There are no blueprints yet. Generate chapter blueprints with the workflow first.',
          ) }],
          details: { total: 0 },
        }
      }

      const list = bps.map((b) => text(
        `  - 第 ${b.chapterNumber} 章: ${b.title || '无标题'}`,
        `  - Chapter ${b.chapterNumber}: ${b.title || 'Untitled'}`,
      )).join('\n')
      return {
        content: [{ type: 'text', text: text(
          `📋 蓝图列表（${bps.length} 个）\n${list}\n\n使用 chapter_number 参数可以读取具体章节蓝图的内容。`,
          `📋 Blueprint list (${bps.length})\n${list}\n\nUse chapter_number to read a specific chapter blueprint.`,
        ) }],
        details: { total: bps.length },
      }
    },
  }
}
