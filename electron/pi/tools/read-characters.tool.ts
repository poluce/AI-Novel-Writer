import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { CharacterRepository } from '../../repositories/character-repository'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

const Schema = Type.Object({
  character_name: Type.Optional(Type.String()),
})

export function createReadCharactersTool(
  language: WritingLanguage,
): AgentTool<typeof Schema, { total: number }> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'Read character cards. List every character or retrieve one character\'s background, personality, appearance, and arc.'
    : '读取小说的角色卡档案。可以获取所有角色列表或指定角色的详细信息（背景、性格、外貌、角色弧等）。'

  return {
    name: 'read_characters',
    label: 'Read Characters',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const chars = CharacterRepository.getAll()
      if (chars.length === 0) {
        return {
          content: [{ type: 'text', text: text(
            '⚠️ 角色池为空，暂无角色卡。建议先创建角色卡。',
            '⚠️ The character roster is empty. Create character cards first.',
          ) }],
          details: { total: 0 },
        }
      }

      const charName = params.character_name
      if (charName) {
        const target = chars.find((c) => c.name.toLowerCase().includes(charName.toLowerCase()))
        if (!target) {
          const available = chars.map((c) => c.name).join(', ')
          throw new Error(text(
            `未找到角色 "${charName}"。可用角色：${available}`,
            `Character "${charName}" was not found. Available characters: ${available}`,
          ))
        }
        const formatted = Object.entries(target)
          .filter(([k, v]) => v && k !== 'id')
          .map(([k, v]) => `**${k}**: ${typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)}`)
          .join('\n')
        return {
          content: [{ type: 'text', text: text(
            `👤 角色卡：${target.name}\n\n${formatted}`,
            `👤 Character card: ${target.name}\n\n${formatted}`,
          ) }],
          details: { total: 1 },
        }
      }

      const list = chars.map((c) => `  - ${c.name} (${c.role})`).join('\n')
      return {
        content: [{ type: 'text', text: text(
          `👤 角色列表（${chars.length} 个）\n${list}\n\n使用 character_name 参数可以读取具体角色的详细信息。`,
          `👤 Character list (${chars.length})\n${list}\n\nUse character_name to read one character in detail.`,
        ) }],
        details: { total: chars.length },
      }
    },
  }
}
