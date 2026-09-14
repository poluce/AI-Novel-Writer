/**
 * domain-proposals — 结构化事实变更提案的唯一校验实现。
 *
 * 主进程的工具在执行前用它校验并落库，渲染层的确认卡片用同一份实现
 * 计算「当前值 → 建议值」差异；两边共用一套字段白名单，避免枚举漂移。
 */

import type { BlueprintData } from '../../electron/repositories/blueprint-repository'
import type { NovelConfig } from './ipc-channels'

/** 由调用方注入的本地化文案函数（写作语言决定中/英）。 */
export type ProposalText = (zhCNText: string, enUSText: string) => string

export interface ProposalFieldDiff {
  field: string
  current: unknown
  proposed: unknown
}

const NOVEL_CONFIG_STRING_FIELDS = new Set<keyof NovelConfig>([
  'genre', 'subGenre', 'targetAudience', 'coreOutline', 'worldSetting', 'goldenFinger',
  'protagonistProfile', 'globalGuidance', 'writingStyle', 'referenceWorks',
])
const NOVEL_CONFIG_NUMBER_FIELDS = new Set<keyof NovelConfig>(['totalChapters', 'wordsPerChapter'])
const NOVEL_CONFIG_ENUM_FIELDS: Partial<Record<keyof NovelConfig, readonly string[]>> = {
  plotStructure: ['three_act', 'heros_journey', 'save_the_cat', 'kishotenketsu', 'multi_thread', 'freeform'],
  narrativePOV: ['third_limited', 'first_person', 'third_omniscient', 'multi_pov'],
  writingLanguage: ['zh-CN', 'en-US'],
}

export type NovelConfigProposal =
  | { valid: true; changes: Partial<NovelConfig>; diffs: ProposalFieldDiff[] }
  | { valid: false; error: string }

function plainChanges(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = args.changes
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * 校验小说配置变更。字段名与枚举取规范值（`narrativePov` → `narrativePOV`，
 * 「简体中文」/「English」→ 语言代码），并给出逐字段差异供确认界面展示。
 */
export function buildNovelConfigProposal(
  args: Record<string, unknown>,
  current: NovelConfig,
  text: ProposalText,
): NovelConfigProposal {
  const candidate = plainChanges(args)
  if (!candidate || Object.keys(candidate).length === 0) {
    return { valid: false, error: text('缺少小说配置变更字段', 'No novel configuration changes were provided') }
  }
  const changes: Record<string, unknown> = {}
  for (const [field, proposed] of Object.entries(candidate)) {
    const canonicalField = field === 'narrativePov' ? 'narrativePOV' : field
    const normalizedValue = canonicalField === 'writingLanguage'
      ? proposed === '简体中文' ? 'zh-CN' : proposed === 'English' ? 'en-US' : proposed
      : proposed
    if (NOVEL_CONFIG_STRING_FIELDS.has(canonicalField as keyof NovelConfig)) {
      if (typeof normalizedValue !== 'string') {
        return { valid: false, error: text(`字段 ${field} 必须是文本`, `Field ${field} must be text`) }
      }
    } else if (NOVEL_CONFIG_NUMBER_FIELDS.has(canonicalField as keyof NovelConfig)) {
      if (!Number.isInteger(normalizedValue) || (normalizedValue as number) <= 0) {
        return { valid: false, error: text(`字段 ${field} 必须是正整数`, `Field ${field} must be a positive integer`) }
      }
    } else if (canonicalField in NOVEL_CONFIG_ENUM_FIELDS) {
      const allowedValues = NOVEL_CONFIG_ENUM_FIELDS[canonicalField as keyof NovelConfig] ?? []
      if (!allowedValues.includes(String(normalizedValue))) {
        return {
          valid: false,
          error: text(
            `字段 ${field} 的值 ${JSON.stringify(normalizedValue)} 不受支持；允许值：${allowedValues.join('、')}`,
            `Field ${field} has unsupported value ${JSON.stringify(normalizedValue)}; allowed values: ${allowedValues.join(', ')}`,
          ),
        }
      }
    } else {
      return { valid: false, error: text(`未知小说配置字段：${field}`, `Unknown novel configuration field: ${field}`) }
    }
    changes[canonicalField] = normalizedValue
  }
  return {
    valid: true,
    changes: changes as Partial<NovelConfig>,
    diffs: Object.entries(changes).map(([field, proposed]) => ({
      field,
      current: current[field as keyof NovelConfig],
      proposed,
    })),
  }
}

const BLUEPRINT_STRING_FIELDS = new Set<keyof BlueprintData>([
  'title', 'role', 'purpose', 'keyEvents', 'suspenseHook', 'userGuidance', 'notes',
])
const BLUEPRINT_FIELD_ALIASES: Record<string, keyof BlueprintData> = {
  作者微操指导: 'userGuidance',
  用户指引: 'userGuidance',
}

export type ChapterBlueprintProposal =
  | { valid: true; chapterNumber: number; changes: Partial<BlueprintData>; diffs: ProposalFieldDiff[] }
  | { valid: false; error: string }

/**
 * 校验章节蓝图变更，并要求 `chapter_number` 与传入的当前蓝图一致，
 * 以免确认界面展示的差异对应的不是同一章。
 */
export function buildChapterBlueprintProposal(
  args: Record<string, unknown>,
  current: BlueprintData,
  text: ProposalText,
): ChapterBlueprintProposal {
  const chapterNumber = args.chapter_number
  if (!Number.isInteger(chapterNumber) || (chapterNumber as number) <= 0 || chapterNumber !== current.chapterNumber) {
    return { valid: false, error: text('目标章节与当前蓝图不一致', 'The target chapter does not match the current blueprint') }
  }
  const candidate = plainChanges(args)
  if (!candidate || Object.keys(candidate).length === 0) {
    return { valid: false, error: text('缺少章节蓝图变更字段', 'No chapter blueprint changes were provided') }
  }
  const changes: Record<string, unknown> = {}
  for (const [field, proposed] of Object.entries(candidate)) {
    const canonicalField = BLUEPRINT_FIELD_ALIASES[field] ?? field
    if (BLUEPRINT_STRING_FIELDS.has(canonicalField as keyof BlueprintData)) {
      if (typeof proposed !== 'string') {
        return { valid: false, error: text(`字段 ${field} 必须是文本`, `Field ${field} must be text`) }
      }
    } else if (canonicalField === 'characters') {
      if (!Array.isArray(proposed) || !proposed.every(item => typeof item === 'string')) {
        return { valid: false, error: text('字段 characters 必须是文本数组', 'Field characters must be an array of text values') }
      }
    } else {
      return { valid: false, error: text(`未知章节蓝图字段：${field}`, `Unknown chapter blueprint field: ${field}`) }
    }
    changes[canonicalField] = proposed
  }
  return {
    valid: true,
    chapterNumber: chapterNumber as number,
    changes: changes as Partial<BlueprintData>,
    diffs: Object.entries(changes).map(([field, proposed]) => ({
      field,
      current: current[field as keyof BlueprintData],
      proposed,
    })),
  }
}
