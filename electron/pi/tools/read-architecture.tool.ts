import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { ProjectCoreRepository } from '../../repositories/project-core-repository'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

/**
 * 全书设定与大纲。角色图谱不在这里返回：角色只有 `read_characters`
 * 一个来源（权威角色名单），避免两个工具对同一事实给出不同口径。
 */
const Section = Type.Union([
  Type.Literal('all'),
  Type.Literal('premise'),
  Type.Literal('worldbuilding'),
  Type.Literal('synopsis'),
])

const Schema = Type.Object({
  section: Type.Optional(Section),
})

const SECTION_LABELS: Record<string, readonly [string, string]> = {
  premise: ['故事前提', 'Story premise'],
  worldbuilding: ['世界观', 'Worldbuilding'],
  synopsis: ['情节大纲', 'Plot outline'],
}

export function createReadArchitectureTool(
  language: WritingLanguage,
): AgentTool<typeof Schema, { sections: string[] }> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'Read the story premise, worldbuilding, and whole-book plot outline. Character facts live in read_characters. Defaults to every section.'
    : '读取故事前提、世界观与全书情节大纲。角色资料请用 read_characters。不传 section 时返回全部。'

  return {
    name: 'read_architecture',
    label: 'Read Architecture',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const core = ProjectCoreRepository.get()
      if (!core) {
        throw new Error(text('项目架构未初始化', 'The project architecture has not been initialized'))
      }

      const requested = params.section ?? 'all'
      const wanted: Array<keyof typeof SECTION_LABELS> = requested === 'all'
        ? ['premise', 'worldbuilding', 'synopsis']
        : [requested]

      const blocks: Array<{ key: keyof typeof SECTION_LABELS; content: string }> = []
      for (const key of wanted) {
        const content = key === 'premise'
          ? core.premise
          : key === 'worldbuilding'
            ? core.worldbuilding
            : core.synopsis
        if (content && content.trim()) blocks.push({ key, content })
      }

      if (blocks.length === 0) {
        return {
          content: [{ type: 'text', text: requested === 'all'
            ? text(
                '⚠️ 架构为空，暂无故事前提、世界观与情节大纲。建议通过工作流生成故事架构。',
                '⚠️ The architecture is empty: no premise, worldbuilding, or plot outline yet. Generate the story architecture with the workflow first.',
              )
            : text(
                `${SECTION_LABELS[requested][0]}尚未生成。`,
                `${SECTION_LABELS[requested][1]} has not been generated yet.`,
              ) }],
          details: { sections: [] },
        }
      }

      const body = blocks.map(({ key, content }) => (
        `## 📄 ${text(...SECTION_LABELS[key])}\n\n${content}`
      )).join('\n\n---\n\n')
      const missing = wanted.filter(key => !blocks.some(block => block.key === key))
      const missingNote = missing.length > 0
        ? `\n\n${text(
            `（未生成：${missing.map(key => text(...SECTION_LABELS[key])).join('、')}）`,
            `(Not generated yet: ${missing.map(key => text(...SECTION_LABELS[key])).join(', ')})`,
          )}`
        : ''

      return {
        content: [{ type: 'text', text: `${text(
          `📐 全书设定与大纲（${blocks.length} 个部分）`,
          `📐 Story architecture (${blocks.length} sections)`,
        )}\n\n${body}${missingNote}` }],
        details: { sections: blocks.map(block => block.key) },
      }
    },
  }
}
