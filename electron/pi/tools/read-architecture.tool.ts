import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { ProjectCoreRepository } from '../../repositories/project-core-repository'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

const Schema = Type.Object({
  file_name: Type.Optional(Type.String()),
})

export function createReadArchitectureTool(
  language: WritingLanguage,
): AgentTool<typeof Schema> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'Read the story architecture, including the premise, worldbuilding, character graph, and plot synopsis.'
    : '读取小说的故事架构文件（四段式架构：故事前提、世界观、角色图谱、剧情大纲等）。是理解小说全局结构的核心工具。'

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

      const fileName = params.file_name
      if (fileName) {
        const isPremise = fileName.includes('前提') || fileName.includes('premise')
        const isWorld = fileName.includes('世界') || fileName.includes('world')
        const isChar = fileName.includes('角色') || fileName.includes('character')
        const isSynopsis = fileName.includes('大纲') || fileName.includes('synopsis')
        let property = ''
        if (isPremise) property = core.premise
        else if (isWorld) property = core.worldbuilding
        else if (isChar) property = core.charactersArch
        else if (isSynopsis) property = core.synopsis

        if (!property) {
          throw new Error(text(
            `架构文件内容为空：${fileName}`,
            `The architecture content is empty: ${fileName}`,
          ))
        }
        return {
          content: [{ type: 'text', text: text(
            `📐 架构文件：${fileName}\n\n${property}`,
            `📐 Architecture: ${fileName}\n\n${property}`,
          ) }],
          details: {},
        }
      }

      const contents: string[] = []
      if (core.premise) contents.push(`## 📄 premise.md\n\n${core.premise}`)
      if (core.worldbuilding) contents.push(`## 📄 worldbuilding.md\n\n${core.worldbuilding}`)
      if (core.charactersArch) contents.push(`## 📄 characters.md\n\n${core.charactersArch}`)
      if (core.synopsis) contents.push(`## 📄 synopsis.md\n\n${core.synopsis}`)

      if (contents.length === 0) {
        return {
          content: [{ type: 'text', text: text(
            '⚠️ 架构为空，暂无架构文件。建议通过工作流生成故事架构。',
            '⚠️ The architecture is empty. Generate the story architecture with the workflow first.',
          ) }],
          details: { files: 0 },
        }
      }

      return {
        content: [{ type: 'text', text: text(
          `📐 故事架构（${contents.length} 个文件）\n\n${contents.join('\n\n---\n\n')}`,
          `📐 Story architecture (${contents.length} files)\n\n${contents.join('\n\n---\n\n')}`,
        ) }],
        details: { files: contents.length },
      }
    },
  }
}
