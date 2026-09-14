import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import {
  CharacterRosterRepository,
  renderCharacterRosterMarkdown,
} from '../../repositories/character-roster-repository'
import type { CharacterRosterEntry } from '../../../src/shared/character-roster'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

const Schema = Type.Object({
  character_name: Type.Optional(Type.String()),
})

function formatState(entry: CharacterRosterEntry): string[] {
  const state = entry.currentState
  if (!state) return []
  const lines = [
    `location: ${state.location}`,
    `powerLevel: ${state.powerLevel}`,
    `physicalState: ${state.physicalState}`,
    `mentalState: ${state.mentalState}`,
    `keyItems: ${state.keyItems}`,
    `recentEvents: ${state.recentEvents}`,
    `updatedAtChapter: ${state.updatedAtChapter}`,
  ].filter(line => !line.endsWith(': ') && !line.endsWith(': 0'))
  return lines
}

function formatEntry(entry: CharacterRosterEntry, english: boolean): string {
  const fields: Array<[string, string]> = [
    [english ? 'Role' : '定位', entry.role],
    [english ? 'Gender' : '性别', entry.gender],
    [english ? 'Age' : '年龄', entry.age],
    [english ? 'Appearance' : '外貌', entry.appearance],
    [english ? 'Personality' : '性格', entry.personality],
    [english ? 'Background' : '背景', entry.background],
    [english ? 'Abilities' : '能力', entry.abilities],
    [english ? 'Motivation' : '动机', entry.motivation],
    [english ? 'Arc' : '弧光', entry.arc],
    [english ? 'Notes' : '备注', entry.notes],
  ]
  const lines = [`# ${entry.name}`]
  for (const [label, value] of fields) {
    if (value) lines.push(`- ${label}: ${value}`)
  }
  for (const relationship of entry.relationships) {
    lines.push(english
      ? `- Relationship: ${relationship.target} (${relationship.relation})`
      : `- 关系：${relationship.target}（${relationship.relation}）`)
  }
  if (entry.legacyRelationshipNotes) {
    lines.push(english
      ? `- Relationship notes: ${entry.legacyRelationshipNotes}`
      : `- 关系备注：${entry.legacyRelationshipNotes}`)
  }
  const state = formatState(entry)
  if (state.length > 0) {
    lines.push(english ? '- Current state:' : '- 当前状态：')
    for (const line of state) lines.push(`  - ${line}`)
  }
  return lines.join('\n')
}

export function createReadCharactersTool(
  language: WritingLanguage,
): AgentTool<typeof Schema, { total: number; status: string }> {
  const english = language === 'en-US'
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = english
    ? 'Read the authoritative character roster: list every character or read one character\'s profile and current state. This is the only source for character facts.'
    : '读取权威角色名单：列出全部角色，或读取单个角色的资料与当前状态。角色事实只有这一个来源。'

  return {
    name: 'read_characters',
    label: 'Read Characters',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const roster = CharacterRosterRepository.read()
      const entries = roster.status === 'ready' ? roster.entries : []

      if (entries.length === 0) {
        // 结构化名单不可用时，只展示升级前保留下来的旧文本证据。
        const legacy = roster.legacyMarkdown?.trim()
        if (legacy) {
          return {
            content: [{ type: 'text', text: `${text(
              `⚠️ 角色名单尚未结构化（状态：${roster.status}）。以下是保留的旧角色图谱原文，仅供参考，修复前不要当作结构化事实写入。`,
              `⚠️ The character roster is not structured yet (status: ${roster.status}). Below is the preserved legacy character-graph text; treat it as reference only until it is repaired.`,
            )}\n\n${legacy}` }],
            details: { total: 0, status: roster.status },
          }
        }
        return {
          content: [{ type: 'text', text: text(
            '⚠️ 角色名单为空，暂无角色。建议先生成故事架构中的角色图谱。',
            '⚠️ The character roster is empty. Generate the character map in the story architecture first.',
          ) }],
          details: { total: 0, status: roster.status },
        }
      }

      const charName = params.character_name
      if (charName) {
        const needle = charName.trim().toLowerCase()
        const target = entries.find(entry => entry.name.toLowerCase().includes(needle))
        if (!target) {
          throw new Error(text(
            `未找到角色 "${charName}"。可用角色：${entries.map(entry => entry.name).join(', ')}`,
            `Character "${charName}" was not found. Available characters: ${entries.map(entry => entry.name).join(', ')}`,
          ))
        }
        return {
          content: [{ type: 'text', text: text(
            `👤 角色档案：${target.name}\n\n${formatEntry(target, english)}`,
            `👤 Character profile: ${target.name}\n\n${formatEntry(target, english)}`,
          ) }],
          details: { total: 1, status: roster.status },
        }
      }

      const list = entries
        .map(entry => `  - ${entry.name} (${entry.role})`)
        .join('\n')
      return {
        content: [{ type: 'text', text: text(
          `👤 角色名单（${entries.length} 个，第 ${roster.revision} 版）\n${list}\n\n传入 character_name 可以读取单个角色的完整资料与当前状态。完整投影：\n\n${renderCharacterRosterMarkdown(entries, language)}`,
          `👤 Character roster (${entries.length} characters, revision ${roster.revision})\n${list}\n\nPass character_name to read one character's full profile and current state. Full projection:\n\n${renderCharacterRosterMarkdown(entries, language)}`,
        ) }],
        details: { total: entries.length, status: roster.status },
      }
    },
  }
}
