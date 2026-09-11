import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { ProjectCoreRepository } from '../../repositories/project-core-repository'
import { BlueprintRepository } from '../../repositories/blueprint-repository'
import { localizeNovelConfigFacts } from '../../../src/shared/novel-config-localization'
import type { WritingLanguage } from '../../../src/shared/writing-language'

const Schema = Type.Object({
  include_config: Type.Optional(Type.Boolean()),
  include_summary: Type.Optional(Type.Boolean()),
})

export function createReadProjectStateTool(
  language: WritingLanguage,
): AgentTool<typeof Schema, { configIncluded: boolean; summaryIncluded: boolean }> {
  const english = language === 'en-US'
  const description = english
    ? 'Read the project-wide state, including novel configuration and recent chapter notes, to understand the overall project context.'
    : '读取项目的全局状态信息，包括小说配置、近章要点等。用于了解项目的整体概况。'

  return {
    name: 'read_project_state',
    label: 'Read Project State',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const includeConfig = params.include_config !== false
      const includeSummary = params.include_summary !== false

      const core = ProjectCoreRepository.get()
      const parts: string[] = [english
        ? `# Project status: "${core?.projectName ?? ''}"\n`
        : `# 📊 项目状态：《${core?.projectName ?? ''}》\n`]

      if (includeConfig) {
        if (core) {
          const localizedFacts = localizeNovelConfigFacts({
            genre: core.genre,
            targetAudience: core.targetAudience,
            plotStructure: core.plotStructure,
            narrativePOV: core.narrativePov,
          }, language)
          parts.push(`${english ? '## Novel configuration' : '## 小说配置'}\n\`\`\`json\n${JSON.stringify({
            projectName: core.projectName,
            genre: localizedFacts.genre,
            subGenre: core.subGenre,
            targetAudience: localizedFacts.targetAudience,
            totalChapters: core.totalChapters,
            wordsPerChapter: core.wordsPerChapter,
            plotStructure: localizedFacts.plotStructure,
            narrativePOV: localizedFacts.narrativePOV,
            writingStyle: core.writingStyle,
          }, null, 2)}\n\`\`\``)
        } else {
          parts.push(english
            ? '## Novel configuration\nFailed to load configuration.'
            : '## 小说配置\n⚠️ 获取配置失败')
        }
      }

      if (includeSummary) {
        const notesParts: string[] = []
        const bps = BlueprintRepository.getAll()
        const sorted = [...bps].sort((a, b) => b.chapterNumber - a.chapterNumber)
        for (const bp of sorted) {
          if (bp.notes && bp.notes.trim()) {
            notesParts.unshift(english
              ? `### Chapter ${bp.chapterNumber} ${bp.title || ''}\n${bp.notes}`
              : `### 第${bp.chapterNumber}章 ${bp.title || ''}\n${bp.notes}`)
            if (notesParts.length >= 5) break
          }
        }

        if (notesParts.length > 0) {
          parts.push(`${english ? '## Recent chapter notes' : '## 近章要点'}\n${notesParts.join('\n\n')}`)
        } else {
          parts.push(english
            ? '## Recent chapter notes\nNo chapter notes yet. Chapter notes are generated after finalization and saved to the blueprint.'
            : '## 近章要点\n暂无章节要点。章节要点会在定稿后自动生成并写入蓝图。')
        }
      }

      return {
        content: [{ type: 'text', text: parts.join('\n\n') }],
        details: { configIncluded: includeConfig, summaryIncluded: includeSummary },
      }
    },
  }
}
