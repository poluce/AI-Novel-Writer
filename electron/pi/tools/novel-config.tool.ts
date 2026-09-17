import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { ProjectCoreRepository } from '../../repositories/project-core-repository'
import type { RendererActionSink } from '../renderer-action'
import {
  buildNovelConfigProposal,
  type ProposalText,
} from '../../../src/shared/domain-proposals'
import type { NovelConfig } from '../../../src/shared/ipc-channels'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

const Action = Type.Union([
  Type.Literal('read', { description: 'Read configuration fields from the project database (default)' }),
  Type.Literal('update', { description: 'Update or fill specified configuration fields in the project database' }),
], { description: 'Operation mode: "read" to inspect existing settings, "update" to fill or modify settings' })

const Field = Type.Union([
  Type.Literal('all', { description: 'All novel configuration fields' }),
  Type.Literal('basic_info', { description: 'Basic metadata: title, genre, subgenre, audience, chapters, words per chapter, structure, POV' }),
  Type.Literal('coreOutline', { description: 'Core story outline: main plot arc and key milestones' }),
  Type.Literal('worldSetting', { description: 'World setting: era, background rules, power/magic/tech system' }),
  Type.Literal('goldenFinger', { description: 'Golden finger / core hook: protagonist advantage, mechanics, limits, and costs' }),
  Type.Literal('protagonistProfile', { description: 'Protagonist profile: name, background, personality, core desire, flaws' }),
  Type.Literal('globalGuidance', { description: 'Global writing guidance: cross-chapter rules, constraints, and instructions' }),
  Type.Literal('writingStyle', { description: 'Writing style: prose rhythm, dialogue density, sensory detail expectations' }),
  Type.Literal('referenceWorks', { description: 'Reference works: mentor novels or reference literature' }),
], { description: 'Configuration field name to read. Defaults to "all"' })

const Schema = Type.Object({
  action: Type.Optional(Action),
  field: Type.Optional(Field),
  coreOutline: Type.Optional(Type.String({ description: 'Full-text core outline: central conflict, main plot chain, and beginning-to-climax overview' })),
  worldSetting: Type.Optional(Type.String({ description: 'World setting details: era, world rules, hierarchy, and core resources' })),
  goldenFinger: Type.Optional(Type.String({ description: 'Protagonist special advantage / cheat / unique mechanism, usage constraints, and progression path' })),
  protagonistProfile: Type.Optional(Type.String({ description: 'Protagonist character card: identity, personality, core motivations, weaknesses, and character arc' })),
  genre: Type.Optional(Type.String({ description: 'Primary novel genre (e.g. Fantasy, Sci-Fi, Urban, Mystery, Historical, Cultivation)' })),
  subGenre: Type.Optional(Type.String({ description: 'Subgenre or tropes (e.g. Rebirth, Cyberpunk, Xianxia, System)' })),
  targetAudience: Type.Optional(Type.String({ description: 'Target audience (e.g. male-oriented, female-oriented, general)' })),
  totalChapters: Type.Optional(Type.Integer({ minimum: 1, description: 'Planned total chapter count (positive integer, e.g. 100)' })),
  wordsPerChapter: Type.Optional(Type.Integer({ minimum: 100, description: 'Target word count per chapter (positive integer, default ~3000)' })),
  plotStructure: Type.Optional(Type.Union([
    Type.Literal('three_act', { description: 'Three-act structure: setup, confrontation, climax' }),
    Type.Literal('heros_journey', { description: 'Hero’s journey: twelve-stage mythic progression' }),
    Type.Literal('save_the_cat', { description: 'Beat sheet: fifteen-beat commercial pacing' }),
    Type.Literal('kishotenketsu', { description: 'Kishōtenketsu: four-part development structure' }),
    Type.Literal('multi_thread', { description: 'Multi-thread: intertwined character storylines' }),
    Type.Literal('freeform', { description: 'Freeform: content-driven adaptable structure' }),
  ], { description: 'Story structure framework' })),
  narrativePOV: Type.Optional(Type.Union([
    Type.Literal('third_limited', { description: 'Third-person limited viewpoint (most standard in fiction)' }),
    Type.Literal('first_person', { description: 'First-person viewpoint ("I")' }),
    Type.Literal('third_omniscient', { description: 'Third-person omniscient viewpoint' }),
    Type.Literal('multi_pov', { description: 'Multiple alternating viewpoints' }),
  ], { description: 'Narrative point of view' })),
  globalGuidance: Type.Optional(Type.String({ description: 'Long-term stable writing rules, cross-chapter prohibitions, and author guidance' })),
  writingStyle: Type.Optional(Type.String({ description: 'Stylistic instructions: pacing, dialogue tone, and descriptive density' })),
  referenceWorks: Type.Optional(Type.String({ description: 'Titles of mentor works or stylistic references' })),
  content: Type.Optional(Type.String({ description: 'Prose content when updating a single designated field via the "field" parameter' })),
  old_text: Type.Optional(Type.String({ description: 'Targeted snippet replacement: exact original excerpt to replace (for modifying just one paragraph in a long outline/setting without rewriting everything)' })),
  new_text: Type.Optional(Type.String({ description: 'Targeted snippet replacement: replacement excerpt' })),
  changes: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: 'Dictionary of field updates (or pass top-level fields directly)' })),
})

const FIELD_ALIASES: Record<string, string> = {
  all: 'all',
  '全部': 'all',
  basic_info: 'basic_info',
  '基本信息': 'basic_info',
  coreOutline: 'coreOutline',
  core_outline: 'coreOutline',
  '核心大纲': 'coreOutline',
  worldSetting: 'worldSetting',
  world_setting: 'worldSetting',
  '世界观设定': 'worldSetting',
  '世界观': 'worldSetting',
  goldenFinger: 'goldenFinger',
  golden_finger: 'goldenFinger',
  '金手指': 'goldenFinger',
  '核心卖点': 'goldenFinger',
  protagonistProfile: 'protagonistProfile',
  protagonist_profile: 'protagonistProfile',
  '主角人设': 'protagonistProfile',
  '主角设定': 'protagonistProfile',
  globalGuidance: 'globalGuidance',
  global_guidance: 'globalGuidance',
  '创作指导': 'globalGuidance',
  '全局指导': 'globalGuidance',
  writingStyle: 'writingStyle',
  writing_style: 'writingStyle',
  '文风': 'writingStyle',
  '文风配置': 'writingStyle',
  referenceWorks: 'referenceWorks',
  reference_works: 'referenceWorks',
  '参考作品': 'referenceWorks',
}

const FIELD_DISPLAY_NAMES: Record<string, [string, string]> = {
  coreOutline: ['核心大纲', 'Core Outline'],
  worldSetting: ['世界观设定', 'World Setting'],
  goldenFinger: ['金手指 / 核心卖点', 'Golden Finger / Core Advantage'],
  protagonistProfile: ['主角人设', 'Protagonist Profile'],
  globalGuidance: ['全局创作指导', 'Global Guidance'],
  writingStyle: ['文风配置', 'Writing Style'],
  referenceWorks: ['参考作品', 'Reference Works'],
  genre: ['类型', 'Genre'],
  subGenre: ['细分类型', 'Subgenre'],
  targetAudience: ['目标受众', 'Target Audience'],
  totalChapters: ['总章数', 'Total Chapters'],
  wordsPerChapter: ['每章字数', 'Words Per Chapter'],
  plotStructure: ['故事结构', 'Story Structure'],
  narrativePOV: ['叙事视角', 'Narrative POV'],
  writingLanguage: ['写作语言', 'Writing Language'],
}

export function createNovelConfigTool(
  language: WritingLanguage,
  rendererAction: RendererActionSink,
): AgentTool<typeof Schema, { action: string; fields?: number }> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'Read or update novel configuration fields: basic info (genre, chapters, POV), core outline, world setting, golden finger, protagonist profile, guidance, style. Directly fills or modifies specified fields.'
    : '读取或修改当前项目的小说配置。支持按字段单独或批量读写：基本信息（类型、章节规模、叙事视角等）、核心大纲、世界观设定、金手指/核心卖点、主角人设、创作指导、文风配置等。在对话中与作者探讨确定后，可直接调用此工具将生成的设定填入小说配置中。'

  return {
    name: 'novel_config',
    label: 'Novel Config',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const core = ProjectCoreRepository.get()
      if (!core) {
        throw new Error(text('项目未打开或未初始化', 'Project is not open or not initialized'))
      }

      // 判定动作类型：显式 action 优先；若传了变更内容则判定为 update，否则判定为 read
      const rawAction = String(params.action ?? '').toLowerCase().trim()
      const isExplicitUpdate = rawAction === 'update' || rawAction === '修改' || rawAction === '更新' || rawAction === '填充'
      const isExplicitRead = rawAction === 'read' || rawAction === '读取' || rawAction === '查看'

      const hasUpdatePayload = Boolean(
        params.changes
        || params.coreOutline
        || params.worldSetting
        || params.goldenFinger
        || params.protagonistProfile
        || params.genre
        || params.subGenre
        || params.targetAudience
        || params.totalChapters
        || params.wordsPerChapter
        || params.plotStructure
        || params.narrativePOV
        || params.globalGuidance
        || params.writingStyle
        || params.referenceWorks
        || (params.field && params.content)
        || (params.old_text && params.new_text),
      )

      const isUpdate = isExplicitUpdate || (!isExplicitRead && hasUpdatePayload)

      if (!isUpdate) {
        // ========== 读取逻辑 ==========
        const targetFieldKey = FIELD_ALIASES[params.field ?? 'all'] ?? 'all'
        const parts: string[] = []

        const formatBasicInfo = () => {
          return [
            `### ${text('基本信息', 'Basic Information')}`,
            `- ${text('书名/项目名', 'Project Name')}: ${core.projectName || '—'}`,
            `- ${text('类型', 'Genre')}: ${core.genre || '—'}${core.subGenre ? ` (${core.subGenre})` : ''}`,
            `- ${text('目标读者', 'Target Audience')}: ${core.targetAudience || '—'}`,
            `- ${text('计划总章数', 'Total Chapters')}: ${core.totalChapters || '—'}`,
            `- ${text('每章目标字数', 'Words Per Chapter')}: ${core.wordsPerChapter || '—'}`,
            `- ${text('故事结构', 'Story Structure')}: ${core.plotStructure || '—'}`,
            `- ${text('叙事视角', 'Narrative POV')}: ${core.narrativePov || '—'}`,
            `- ${text('写作语言', 'Writing Language')}: ${core.writingLanguage || '—'}`,
          ].join('\n')
        }

        if (targetFieldKey === 'all' || targetFieldKey === 'basic_info') {
          parts.push(formatBasicInfo())
        }

        const documentFields: Array<[keyof typeof core, string, string]> = [
          ['coreOutline', '核心大纲', 'Core Outline'],
          ['worldSetting', '世界观设定', 'World Setting'],
          ['goldenFinger', '金手指 / 核心卖点', 'Golden Finger / Advantage'],
          ['protagonistProfile', '主角人设', 'Protagonist Profile'],
          ['globalGuidance', '全局创作指导', 'Global Guidance'],
          ['writingStyle', '文风配置', 'Writing Style'],
          ['referenceWorks', '参考作品', 'Reference Works'],
        ]

        for (const [key, zh, en] of documentFields) {
          if (targetFieldKey === 'all' || targetFieldKey === key) {
            const val = String(core[key] ?? '').trim()
            parts.push(`### ${text(zh, en)}\n${val ? val : text('（暂无设定）', '(Empty)')}`)
          }
        }

        return {
          content: [{
            type: 'text',
            text: parts.join('\n\n'),
          }],
          details: { action: 'read' },
        }
      }

      // ========== 局部片段精准替换逻辑 ==========
      if (params.old_text && params.new_text) {
        const targetFieldKey = FIELD_ALIASES[params.field ?? 'coreOutline'] ?? (params.field ?? 'coreOutline')
        const currentVal = String((core as unknown as Record<string, unknown>)[targetFieldKey] ?? '')
        if (!currentVal.includes(params.old_text)) {
          const entry = FIELD_DISPLAY_NAMES[targetFieldKey]
          const fieldLabel = entry ? text(entry[0], entry[1]) : targetFieldKey
          throw new Error(text(
            `在小说配置【${fieldLabel}】中未找到指定的待替换原文片段。请先通过 read 读取该字段核对当前原文。`,
            `The specified excerpt was not found in novel configuration [${fieldLabel}]. Please read the field first to verify current text.`,
          ))
        }

        const updatedVal = currentVal.replace(params.old_text, params.new_text)
        const isPOV = targetFieldKey === 'narrativePOV' || targetFieldKey === 'narrativePov'
        ProjectCoreRepository.update({
          ...(isPOV ? { narrativePov: updatedVal } : { [targetFieldKey]: updatedVal }),
        } as Parameters<typeof ProjectCoreRepository.update>[0])

        rendererAction({ type: 'refresh_project_config' })

        const entry = FIELD_DISPLAY_NAMES[targetFieldKey]
        const fieldLabel = entry ? text(entry[0], entry[1]) : targetFieldKey
        return {
          content: [{
            type: 'text',
            text: text(
              `已在小说配置【${fieldLabel}】中精准替换指定段落（原文 ${params.old_text.length} 字 → 新文 ${params.new_text.length} 字，其余全文完整保留未动）。`,
              `Successfully replaced targeted paragraph in novel configuration [${fieldLabel}] (${params.old_text.length} -> ${params.new_text.length} chars, rest of content preserved verbatim).`,
            ),
          }],
          details: { action: 'update', fields: 1 },
        }
      }

      // ========== 整体字段写入 / 填充逻辑 ==========
      const current = {
        ...(core ?? {}),
        narrativePOV: core?.narrativePov,
      } as unknown as NovelConfig

      const proposal = buildNovelConfigProposal(
        params as Record<string, unknown>,
        current,
        text as ProposalText,
      )
      if (!proposal.valid) throw new Error(proposal.error)
      const changes = proposal.changes as Record<string, unknown>

      const { narrativePOV, ...rest } = changes
      ProjectCoreRepository.update({
        ...rest,
        ...(narrativePOV !== undefined ? { narrativePov: narrativePOV as string } : {}),
      } as Parameters<typeof ProjectCoreRepository.update>[0])

      rendererAction({ type: 'refresh_project_config' })

      const updatedNames = Object.keys(changes).map(k => {
        const entry = FIELD_DISPLAY_NAMES[k]
        return entry ? text(entry[0], entry[1]) : k
      })

      return {
        content: [{
          type: 'text',
          text: text(
            `已成功更新小说配置（${updatedNames.join('、')}）`,
            `Successfully updated novel configuration (${updatedNames.join(', ')})`,
          ),
        }],
        details: { action: 'update', fields: Object.keys(changes).length },
      }
    },
  }
}
