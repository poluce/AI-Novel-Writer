/**
 * domain-proposals — 结构化事实变更提案的唯一校验实现。
 *
 * 主进程的工具在执行前用它校验并落库，渲染层的确认卡片用同一份实现
 * 计算「当前值 → 建议值」差异；两边共用一套字段白名单，避免枚举漂移。
 */

import type { BlueprintData } from './blueprint'
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

const NOVEL_CONFIG_FIELD_ALIASES: Record<string, keyof NovelConfig> = {
  genre: 'genre',
  '类型': 'genre',
  '小说类型': 'genre',
  '题材': 'genre',

  subGenre: 'subGenre',
  sub_genre: 'subGenre',
  '细分类型': 'subGenre',
  '子类型': 'subGenre',

  targetAudience: 'targetAudience',
  target_audience: 'targetAudience',
  '目标读者': 'targetAudience',
  '目标受众': 'targetAudience',
  '受众': 'targetAudience',

  totalChapters: 'totalChapters',
  total_chapters: 'totalChapters',
  '总章节数': 'totalChapters',
  '总章数': 'totalChapters',

  wordsPerChapter: 'wordsPerChapter',
  words_per_chapter: 'wordsPerChapter',
  '每章字数': 'wordsPerChapter',
  '单章字数': 'wordsPerChapter',

  plotStructure: 'plotStructure',
  plot_structure: 'plotStructure',
  '情节结构': 'plotStructure',
  '故事结构': 'plotStructure',

  narrativePOV: 'narrativePOV',
  narrativePov: 'narrativePOV',
  narrative_pov: 'narrativePOV',
  '叙事视角': 'narrativePOV',
  '视角': 'narrativePOV',

  coreOutline: 'coreOutline',
  core_outline: 'coreOutline',
  '核心大纲': 'coreOutline',
  '大纲': 'coreOutline',

  worldSetting: 'worldSetting',
  world_setting: 'worldSetting',
  '世界设定': 'worldSetting',
  '世界观设定': 'worldSetting',
  '世界观': 'worldSetting',

  goldenFinger: 'goldenFinger',
  golden_finger: 'goldenFinger',
  '金手指': 'goldenFinger',
  '核心卖点': 'goldenFinger',
  '卖点': 'goldenFinger',

  protagonistProfile: 'protagonistProfile',
  protagonist_profile: 'protagonistProfile',
  '主角设定': 'protagonistProfile',
  '主角人设': 'protagonistProfile',
  '主角档案': 'protagonistProfile',

  globalGuidance: 'globalGuidance',
  global_guidance: 'globalGuidance',
  '全局指导': 'globalGuidance',
  '创作指导': 'globalGuidance',
  '全局写作要求': 'globalGuidance',

  writingStyle: 'writingStyle',
  writing_style: 'writingStyle',
  '写作风格': 'writingStyle',
  '文风': 'writingStyle',
  '文风配置': 'writingStyle',

  referenceWorks: 'referenceWorks',
  reference_works: 'referenceWorks',
  '参考作品': 'referenceWorks',
  '参考书目': 'referenceWorks',

  writingLanguage: 'writingLanguage',
  writing_language: 'writingLanguage',
  '写作语言': 'writingLanguage',
}

const PLOT_STRUCTURE_VALUE_ALIASES: Record<string, string> = {
  '三幕结构': 'three_act',
  '英雄之旅': 'heros_journey',
  '节拍表': 'save_the_cat',
  '起承转合': 'kishotenketsu',
  '多线叙事': 'multi_thread',
  '自由结构': 'freeform',
}

const NARRATIVE_POV_VALUE_ALIASES: Record<string, string> = {
  '第一人称': 'first_person',
  '第三人称有限视角': 'third_limited',
  '第三人称全知视角': 'third_omniscient',
  '多视角轮换': 'multi_pov',
}

export type NovelConfigProposal =
  | { valid: true; changes: Partial<NovelConfig>; diffs: ProposalFieldDiff[] }
  | { valid: false; error: string }

function plainChanges(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = args.changes
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (args.field && (args.content !== undefined || args.value !== undefined || args.text !== undefined)) {
    return { [String(args.field)]: args.content ?? args.value ?? args.text }
  }
  const IGNORED_META_KEYS = new Set(['action', 'field', 'content', 'value', 'text', 'blueprint_changes', 'chapter_number', 'old_text', 'new_text', 'blueprints'])
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (!IGNORED_META_KEYS.has(k) && v !== undefined) {
      rest[k] = v
    }
  }
  return Object.keys(rest).length > 0 ? rest : undefined
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
    const canonicalField = NOVEL_CONFIG_FIELD_ALIASES[field] ?? (field === 'narrativePov' ? 'narrativePOV' : field)
    let normalizedValue = canonicalField === 'writingLanguage'
      ? proposed === '简体中文' ? 'zh-CN' : proposed === 'English' ? 'en-US' : proposed
      : proposed
    if (canonicalField === 'plotStructure' && typeof normalizedValue === 'string') {
      normalizedValue = PLOT_STRUCTURE_VALUE_ALIASES[normalizedValue] ?? normalizedValue
    }
    if (canonicalField === 'narrativePOV' && typeof normalizedValue === 'string') {
      normalizedValue = NARRATIVE_POV_VALUE_ALIASES[normalizedValue] ?? normalizedValue
    }
    if (NOVEL_CONFIG_NUMBER_FIELDS.has(canonicalField as keyof NovelConfig)) {
      if (typeof normalizedValue === 'string' && /^\d+$/.test(normalizedValue.trim())) {
        normalizedValue = parseInt(normalizedValue.trim(), 10)
      }
    }
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

export function defaultEmptyBlueprint(chapterNumber: number): BlueprintData {
  return {
    chapterNumber,
    title: '',
    role: '发展',
    purpose: '',
    keyEvents: '',
    characters: [],
    suspenseHook: '',
    userGuidance: '',
    notes: '',
    notesUpdatedAt: '',
  }
}

const BLUEPRINT_STRING_FIELDS = new Set<keyof BlueprintData>([
  'title', 'role', 'purpose', 'keyEvents', 'suspenseHook', 'userGuidance', 'notes',
])
const BLUEPRINT_FIELD_ALIASES: Record<string, keyof BlueprintData> = {
  title: 'title',
  '标题': 'title',
  '章节标题': 'title',

  role: 'role',
  '作用': 'role',
  '章节作用': 'role',

  purpose: 'purpose',
  '目的': 'purpose',
  '章节目的': 'purpose',
  '核心目标': 'purpose',

  keyEvents: 'keyEvents',
  key_events: 'keyEvents',
  '关键事件': 'keyEvents',
  '情节': 'keyEvents',
  '剧情': 'keyEvents',

  characters: 'characters',
  '角色': 'characters',
  '出场角色': 'characters',
  '登场人物': 'characters',

  suspenseHook: 'suspenseHook',
  suspense_hook: 'suspenseHook',
  '悬念': 'suspenseHook',
  '悬念钩子': 'suspenseHook',
  '钩子': 'suspenseHook',

  userGuidance: 'userGuidance',
  user_guidance: 'userGuidance',
  '作者微操指导': 'userGuidance',
  '用户指引': 'userGuidance',
  '指导': 'userGuidance',

  notes: 'notes',
  '备注': 'notes',
  '备忘': 'notes',
  '伏笔': 'notes',
}

export type ChapterBlueprintProposal =
  | { valid: true; chapterNumber: number; changes: Partial<BlueprintData>; diffs: ProposalFieldDiff[]; isNewCreation?: boolean }
  | { valid: false; error: string }

/**
 * 校验章节蓝图变更，若目标章节尚未创建，则使用空白基线，支持全新创建与已有修改。
 */
export function buildChapterBlueprintProposal(
  args: Record<string, unknown>,
  currentBlueprint: BlueprintData | null | undefined,
  text: ProposalText,
): ChapterBlueprintProposal {
  const chapterNumber = args.chapter_number
  if (!Number.isInteger(chapterNumber) || (chapterNumber as number) <= 0) {
    return { valid: false, error: text('章节号无效，必须为正整数', 'The chapter number is invalid') }
  }

  const isNewCreation = !currentBlueprint
  const current = currentBlueprint ?? defaultEmptyBlueprint(chapterNumber as number)

  if (chapterNumber !== current.chapterNumber) {
    return { valid: false, error: text('目标章节与当前蓝图不一致', 'The target chapter does not match the current blueprint') }
  }

  const candidate = plainChanges(args) ?? {}

  // 支持对长文本字段进行精准局部替换（如替换 keyEvents 中的某个段落）
  if (typeof args.old_text === 'string' && typeof args.new_text === 'string') {
    const targetField = String(args.field || 'keyEvents')
    const canonicalField = BLUEPRINT_FIELD_ALIASES[targetField] ?? targetField
    const currentText = typeof current[canonicalField as keyof BlueprintData] === 'string'
      ? (current[canonicalField as keyof BlueprintData] as string)
      : ''
    if (!currentText.includes(args.old_text)) {
      return { valid: false, error: text(`未在 ${targetField} 中找到待替换的原文本`, `The original text to replace was not found in ${targetField}`) }
    }
    candidate[canonicalField] = currentText.replace(args.old_text, args.new_text)
  }

  if (Object.keys(candidate).length === 0) {
    return { valid: false, error: text('缺少章节蓝图变更字段', 'No chapter blueprint changes were provided') }
  }

  const changes: Record<string, unknown> = {}
  for (const [field, proposed] of Object.entries(candidate)) {
    const canonicalField = BLUEPRINT_FIELD_ALIASES[field] ?? field
    let normalizedValue = proposed
    if (BLUEPRINT_STRING_FIELDS.has(canonicalField as keyof BlueprintData)) {
      if (typeof proposed !== 'string') {
        return { valid: false, error: text(`字段 ${field} 必须是文本`, `Field ${field} must be text`) }
      }
    } else if (canonicalField === 'characters') {
      if (Array.isArray(proposed)) {
        if (!proposed.every(item => typeof item === 'string')) {
          return { valid: false, error: text('字段 characters 必须是文本数组', 'Field characters must be an array of text values') }
        }
      } else if (typeof proposed === 'string') {
        // 容错：允许模型传入逗号分隔的角色名称
        normalizedValue = proposed.split(/[,，、\s]+/).filter(Boolean)
      } else {
        return { valid: false, error: text('字段 characters 必须是文本数组', 'Field characters must be an array of text values') }
      }
    } else {
      return { valid: false, error: text(`未知章节蓝图字段：${field}`, `Unknown chapter blueprint field: ${field}`) }
    }
    changes[canonicalField] = normalizedValue
  }
  return {
    valid: true,
    chapterNumber: chapterNumber as number,
    changes: changes as Partial<BlueprintData>,
    isNewCreation,
    diffs: Object.entries(changes).map(([field, proposed]) => ({
      field,
      current: isNewCreation ? '（未创建）' : (current[field as keyof BlueprintData] ?? ''),
      proposed,
    })),
  }
}
