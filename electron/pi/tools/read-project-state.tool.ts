import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { ProjectCoreRepository } from '../../repositories/project-core-repository'
import { BlueprintRepository } from '../../repositories/blueprint-repository'
import { DraftRepository } from '../../repositories/draft-repository'
import { localizeNovelConfigFacts } from '../../../src/shared/novel-config-localization'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

/** 单次返回的最大章节行数，避免几千章的项目把结果撑爆。 */
const MAX_CHAPTER_ROWS = 200

const Section = Type.Union([
  Type.Literal('config'),
  Type.Literal('progress'),
  Type.Literal('recent_notes'),
  Type.Literal('blueprints'),
])

const Schema = Type.Object({
  sections: Type.Optional(Type.Array(Section)),
})

const ALL_SECTIONS = ['config', 'progress', 'recent_notes', 'blueprints'] as const
type SectionKey = (typeof ALL_SECTIONS)[number]

export function createReadProjectStateTool(
  language: WritingLanguage,
): AgentTool<typeof Schema, { sections: string[]; chapters: number }> {
  const english = language === 'en-US'
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = english
    ? 'Read the project overview: novel configuration, chapter progress (blueprint/draft/finalized per chapter), recent chapter notes, and the blueprint list. This is the single entry point for "where does this project stand"; read a specific chapter with read_blueprint.'
    : '读取项目总览：小说配置、章节进度（每章是否有蓝图/草稿/定稿）、近章要点与蓝图清单。了解「项目现在写到哪了」用这一个工具即可；单章细节用 read_blueprint。'

  return {
    name: 'read_project_state',
    label: 'Read Project State',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const requested = params.sections?.filter((section): section is SectionKey => (
        (ALL_SECTIONS as readonly string[]).includes(section)
      ))
      const sections = requested && requested.length > 0 ? [...new Set(requested)] : [...ALL_SECTIONS]
      const wants = (section: SectionKey) => sections.includes(section)

      const core = ProjectCoreRepository.get()
      const parts: string[] = [english
        ? `# Project status: "${core?.projectName ?? ''}"\n`
        : `# 📊 项目状态：《${core?.projectName ?? ''}》\n`]

      if (wants('config')) {
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

      const blueprints = BlueprintRepository.getAll()

      if (wants('progress')) {
        const drafts = DraftRepository.listAll()
        const bpNums = new Set(blueprints.map(blueprint => blueprint.chapterNumber))
        const draftNums = new Set(drafts.map(draft => draft.chapterNumber))
        const finalizedNums = new Set(drafts
          .filter(draft => draft.status === 'finalized')
          .map(draft => draft.chapterNumber))
        const allNums = [...new Set([...bpNums, ...draftNums, ...finalizedNums])].sort((a, b) => a - b)

        if (allNums.length === 0) {
          parts.push(english
            ? '## Chapter progress\nNo chapter data yet. Generate the story architecture and chapter blueprints first.'
            : '## 章节进度\n暂无章节数据。建议先生成故事架构和章节蓝图。')
        } else {
          const shown = allNums.slice(0, MAX_CHAPTER_ROWS)
          const rows = shown.map(num => (
            `| ${num} | ${bpNums.has(num) ? '✅' : '❌'} | ${draftNums.has(num) ? '✅' : '❌'} | ${finalizedNums.has(num) ? '✅' : '❌'} |`
          ))
          const table = `${english ? '| Chapter | Blueprint | Draft | Finalized |' : '| 章节 | 蓝图 | 草稿 | 定稿 |'}\n| --- | --- | --- | --- |\n${rows.join('\n')}`
          const truncated = allNums.length > shown.length
            ? text(`\n（共 ${allNums.length} 章，仅列出前 ${shown.length} 章）`, `\n(${allNums.length} chapters total; showing the first ${shown.length})`)
            : ''
          parts.push(`${english ? '## Chapter progress' : '## 章节进度'}\n\n${table}\n\n${text(
            `总计：${allNums.length} 个章节，${bpNums.size} 个蓝图，${draftNums.size} 个草稿，${finalizedNums.size} 个定稿`,
            `Total: ${allNums.length} chapters, ${bpNums.size} blueprints, ${draftNums.size} drafts, ${finalizedNums.size} finalized`,
          )}${truncated}`)
        }
      }

      if (wants('recent_notes')) {
        const notesParts: string[] = []
        const sorted = [...blueprints].sort((a, b) => b.chapterNumber - a.chapterNumber)
        for (const blueprint of sorted) {
          if (blueprint.notes && blueprint.notes.trim()) {
            notesParts.unshift(english
              ? `### Chapter ${blueprint.chapterNumber} ${blueprint.title || ''}\n${blueprint.notes}`
              : `### 第${blueprint.chapterNumber}章 ${blueprint.title || ''}\n${blueprint.notes}`)
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

      if (wants('blueprints')) {
        if (blueprints.length === 0) {
          parts.push(text('## 蓝图清单\n⚠️ 蓝图为空。建议先通过工作流生成章节蓝图。', '## Blueprints\n⚠️ There are no blueprints yet. Generate chapter blueprints with the workflow first.'))
        } else {
          const sorted = [...blueprints].sort((a, b) => a.chapterNumber - b.chapterNumber)
          const shown = sorted.slice(0, MAX_CHAPTER_ROWS)
          const list = shown.map(blueprint => text(
            `  - 第 ${blueprint.chapterNumber} 章: ${blueprint.title || '无标题'}`,
            `  - Chapter ${blueprint.chapterNumber}: ${blueprint.title || 'Untitled'}`,
          )).join('\n')
          const truncated = sorted.length > shown.length
            ? text(`\n（共 ${sorted.length} 章，仅列出前 ${shown.length} 章）`, `\n(${sorted.length} chapters total; showing the first ${shown.length})`)
            : ''
          parts.push(`${text(`## 蓝图清单（${sorted.length} 个）`, `## Blueprints (${sorted.length})`)}\n${list}${truncated}\n\n${text(
            '使用 read_blueprint 并传入 chapter_number 读取某一章的完整规划。',
            'Use read_blueprint with chapter_number to read one chapter\'s full plan.',
          )}`)
        }
      }

      return {
        content: [{ type: 'text', text: parts.join('\n\n') }],
        details: { sections, chapters: blueprints.length },
      }
    },
  }
}
