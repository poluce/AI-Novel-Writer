import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { ProjectCoreRepository } from '../../repositories/project-core-repository'
import type { RendererActionSink } from '../renderer-action'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

const STRING_FIELDS = new Set([
  'genre', 'subGenre', 'targetAudience', 'coreOutline', 'worldSetting', 'goldenFinger',
  'protagonistProfile', 'globalGuidance', 'writingStyle', 'referenceWorks',
])
const NUMBER_FIELDS = new Set(['totalChapters', 'wordsPerChapter'])
const ENUM_FIELDS: Record<string, readonly string[]> = {
  plotStructure: ['three_act', 'heros_journey', 'save_the_cat', 'kishotenketsu', 'multi_thread', 'freeform'],
  narrativePOV: ['third_limited', 'first_person', 'third_omniscient', 'multi_pov'],
  writingLanguage: ['zh-CN', 'en-US'],
}

const Schema = Type.Object({
  changes: Type.Record(Type.String(), Type.Unknown()),
  blueprint_changes: Type.Optional(Type.Array(Type.Unknown())),
})

export function createProposeNovelConfigTool(
  language: WritingLanguage,
  rendererAction: RendererActionSink,
): AgentTool<typeof Schema, { fields: number }> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'Propose changes to the novel configuration. The app shows a diff and impact preview, then writes only after user approval.'
    : '提出小说配置字段变更。应用会展示当前值、建议值与一次性影响预览，必须由用户批准后才写入。'

  return {
    name: 'propose_novel_config',
    label: 'Propose Novel Config',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const candidate = params.changes
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || Object.keys(candidate).length === 0) {
        throw new Error(text('缺少小说配置变更字段', 'No novel configuration changes were provided'))
      }

      const changes: Record<string, unknown> = {}
      for (const [field, proposed] of Object.entries(candidate)) {
        const canonicalField = field === 'narrativePov' ? 'narrativePOV' : field
        const normalizedValue = canonicalField === 'writingLanguage'
          ? proposed === '简体中文' ? 'zh-CN' : proposed === 'English' ? 'en-US' : proposed
          : proposed
        if (STRING_FIELDS.has(canonicalField)) {
          if (typeof normalizedValue !== 'string') throw new Error(text(`字段 ${field} 必须是文本`, `Field ${field} must be text`))
        } else if (NUMBER_FIELDS.has(canonicalField)) {
          if (!Number.isInteger(normalizedValue) || (normalizedValue as number) <= 0) throw new Error(text(`字段 ${field} 必须是正整数`, `Field ${field} must be a positive integer`))
        } else if (canonicalField in ENUM_FIELDS) {
          const allowed = ENUM_FIELDS[canonicalField] ?? []
          if (!allowed.includes(String(normalizedValue))) throw new Error(text(`字段 ${field} 的值 ${JSON.stringify(normalizedValue)} 不受支持`, `Field ${field} has unsupported value ${JSON.stringify(normalizedValue)}`))
        } else {
          throw new Error(text(`未知小说配置字段：${field}`, `Unknown novel configuration field: ${field}`))
        }
        changes[canonicalField] = normalizedValue
      }

      const { narrativePOV, ...rest } = changes
      ProjectCoreRepository.update({
        ...rest,
        ...(narrativePOV !== undefined ? { narrativePov: narrativePOV as string } : {}),
      } as Parameters<typeof ProjectCoreRepository.update>[0])

      rendererAction({ type: 'refresh_project_config' })

      return {
        content: [{ type: 'text', text: text(
          `小说配置已更新（${Object.keys(changes).length} 个字段）`,
          `Novel configuration updated (${Object.keys(changes).length} fields)`,
        ) }],
        details: { fields: Object.keys(changes).length },
      }
    },
  }
}
