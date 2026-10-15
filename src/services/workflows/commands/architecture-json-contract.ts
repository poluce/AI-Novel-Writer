import type { NovelConfig } from '../../../shared/ipc-channels'
import type { WritingLanguage } from '../../../shared/writing-language'
import { CHARACTER_ROSTER_ROLES, type CharacterRosterEntry } from '../../../shared/character-roster'
import { GENERATED_GLOBAL_GUIDANCE_MAX_CHARS } from '../novel-config-expansion'
import { internalPrompt } from '../../../prompts/internal/load'
import { parseModelJson } from '../workflow-utils'
import { promptLanguageText } from '../../prompt-language'

const PLOT_STRUCTURES = new Set<NovelConfig['plotStructure']>([
  'three_act',
  'heros_journey',
  'save_the_cat',
  'kishotenketsu',
  'multi_thread',
  'freeform',
])
const NARRATIVE_POVS = new Set<NovelConfig['narrativePOV']>([
  'third_limited',
  'first_person',
  'third_omniscient',
  'multi_pov',
])
const REQUIRED_CONFIG_TEXT_FIELDS = [
  'genre',
  'targetAudience',
  'subGenre',
  'coreOutline',
  'worldSetting',
  'goldenFinger',
  'protagonistProfile',
  'globalGuidance',
  'writingStyle',
] as const

type RequiredConfigTextField = (typeof REQUIRED_CONFIG_TEXT_FIELDS)[number]

function requiredPlotStructure(value: unknown): NovelConfig['plotStructure'] {
  if (typeof value !== 'string' || !PLOT_STRUCTURES.has(value as NovelConfig['plotStructure'])) {
    throw new Error('AI 返回的小说配置包含非法 plotStructure')
  }
  return value as NovelConfig['plotStructure']
}

function requiredNarrativePov(value: unknown): NovelConfig['narrativePOV'] {
  if (typeof value !== 'string' || !NARRATIVE_POVS.has(value as NovelConfig['narrativePOV'])) {
    throw new Error('AI 返回的小说配置包含非法 narrativePOV')
  }
  return value as NovelConfig['narrativePOV']
}

function assertAuthorLockedPositiveInteger(candidate: unknown, expected: number, field: string): void {
  if (candidate === undefined) return
  if (
    typeof candidate !== 'number'
    || !Number.isSafeInteger(candidate)
    || candidate <= 0
    || candidate !== expected
  ) {
    throw new Error(`AI 返回的小说配置包含无效 ${field}，不得回退或覆盖作者设置`)
  }
}

function requiredConfigTextFields(value: Record<string, unknown>): Record<RequiredConfigTextField, string> {
  const textFields = {} as Record<RequiredConfigTextField, string>
  for (const field of REQUIRED_CONFIG_TEXT_FIELDS) {
    const candidate = value[field]
    if (typeof candidate !== 'string' || !candidate.trim()) {
      throw new Error(`AI 返回的小说配置缺少非空字段：${field}`)
    }
    textFields[field] = candidate.trim()
  }
  return textFields
}


/**
 * 正在重新生成的架构块已有内容。
 *
 * 重新生成必须建立在作者已确认的现有文本之上；因此把当前值作为权威参考随提示词
 * 一起发送，明确禁止整段重写、删除或反转作者明确设定。
 */
export function existingAuthorContentBlock(
  existing: string | null | undefined,
  language: WritingLanguage,
  labelZh: string,
  labelEn: string,
): string {
  const content = (existing ?? '').trim()
  if (!content) return ''
  return promptLanguageText(
    language,
    `【作者已有${labelZh}（权威参考）】
以下是作者已经确认并保留的现有${labelZh}。请在完整保留其中事实、人物、设定与结构的前提下补充或润色，不得整段重写、删除或反转作者的明确设定：

${content}`,
    `[Existing author ${labelEn} — authoritative reference]
The author already confirmed this ${labelEn}. Preserve its facts, characters, settings, and structure while refining or extending it. Never rewrite it wholesale, delete it, or reverse explicit author decisions:

${content}`,
  )
}

export function buildNovelConfigJSONContract(
  totalChapters: number,
  wordsPerChapter: number,
  writingLanguage: WritingLanguage,
): string {
  return internalPrompt('novel_config_json_contract', writingLanguage, {
    total_chapters: totalChapters,
    words_per_chapter: wordsPerChapter,
    max_chars: GENERATED_GLOBAL_GUIDANCE_MAX_CHARS,
  })
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function decodeCompleteNovelConfig(
  contentOrArtifact: string | Record<string, unknown>,
  expectedTotalChapters: number,
  expectedWordsPerChapter: number,
): NovelConfig {
  let value: unknown
  try {
    value = parseModelJson<unknown>(contentOrArtifact)
  } catch {
    throw new Error('AI 返回的小说配置不是完整 JSON 对象')
  }
  if (!isRecord(value)) throw new Error('AI 返回的小说配置必须是 JSON 对象')

  const textFields = requiredConfigTextFields(value)
  const plotStructure = requiredPlotStructure(value.plotStructure)
  const narrativePOV = requiredNarrativePov(value.narrativePOV)
  assertAuthorLockedPositiveInteger(value.totalChapters, expectedTotalChapters, 'totalChapters')
  assertAuthorLockedPositiveInteger(value.wordsPerChapter, expectedWordsPerChapter, 'wordsPerChapter')
  if (value.referenceWorks !== undefined && typeof value.referenceWorks !== 'string') {
    throw new Error('AI 返回的小说配置包含无效 referenceWorks')
  }

  const config: NovelConfig = {
    genre: textFields.genre,
    targetAudience: textFields.targetAudience,
    subGenre: textFields.subGenre,
    totalChapters: expectedTotalChapters,
    wordsPerChapter: expectedWordsPerChapter,
    plotStructure,
    narrativePOV,
    coreOutline: textFields.coreOutline,
    worldSetting: textFields.worldSetting,
    goldenFinger: textFields.goldenFinger,
    protagonistProfile: textFields.protagonistProfile,
    globalGuidance: textFields.globalGuidance,
    writingStyle: textFields.writingStyle,
  }
  if (typeof value.referenceWorks === 'string') {
    config.referenceWorks = value.referenceWorks.trim()
  }
  return config
}

/**
 * 不可由设置页模板覆盖的结构契约。用户仍可调整角色创作指导，但角色身份
 * 不再依赖 Markdown 标题或后续第二次模型提取。
 */
export interface CharacterIdentitySlot {
  slotId: string
  name: string
  role: CharacterRosterEntry['role']
  narrativeDuty: string
  relations: Array<{ targetSlotId: string; relation: string }>
}

export interface CharacterDetailOutput extends Omit<CharacterRosterEntry, 'relationships'> {
  slotId: string
  relationships?: unknown
}

export const MIN_CHARACTER_SLOTS = 3
export const MAX_CHARACTER_SLOTS = 8
export const CHARACTER_DETAIL_BATCH_SIZE = 3
export const CHARACTER_DETAIL_DESCRIPTION_MAX_CHARS = 120
export const CHARACTER_STATE_TEXT_MAX_CHARS = 80
export const CHARACTER_DETAIL_DESCRIPTION_FIELDS = [
  'appearance', 'personality', 'background', 'abilities', 'motivation', 'arc', 'notes',
] as const
export const CHARACTER_STATE_TEXT_FIELDS = [
  'location', 'powerLevel', 'physicalState', 'mentalState', 'keyItems', 'recentEvents',
] as const
export const MAX_CHARACTER_STRUCTURED_CONTEXT_UTF8_BYTES = 32_768

export function promptUtf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function findCompleteJsonObjectEnd(source: string, start: number): number | undefined {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
      if (depth < 0) return undefined
    }
  }
  return undefined
}

export function extractSingleCompleteJsonObject(content: string): string {
  const source = content.trim()
  const candidates: string[] = []
  let searchFrom = 0
  while (searchFrom < source.length) {
    const start = source.indexOf('{', searchFrom)
    if (start === -1) break
    const end = findCompleteJsonObjectEnd(source, start)
    if (end === undefined) throw new Error('AI 返回包含截断 JSON 对象片段')

    const candidate = source.slice(start, end + 1)
    try {
      if (isRecord(JSON.parse(candidate))) candidates.push(candidate)
    } catch {
      // Keep scanning for the one complete JSON object; malformed candidates
      // are not repaired or accepted.
    }
    searchFrom = end + 1
  }

  if (candidates.length === 1) return candidates[0]
  if (candidates.length > 1) throw new Error('AI 返回包含多个完整 JSON 对象，无法确定唯一结构化结果')
  throw new Error('AI 返回未包含一个完整 JSON 对象')
}

function decodeIdentityRelation(
  relation: unknown,
  slotIndex: number,
  relationIndex: number,
): { targetSlotId: string; relation: string } {
  if (!isRecord(relation)) {
    throw new Error(`角色身份清单第 ${slotIndex + 1} 项关系 ${relationIndex + 1} 无效`)
  }
  const targetSlotId = normalizeCharacterSlotId(relation.targetSlotId)
  if (targetSlotId === undefined || typeof relation.relation !== 'string' || !relation.relation.trim()) {
    throw new Error(`角色身份清单第 ${slotIndex + 1} 项关系 ${relationIndex + 1} 无效`)
  }
  return { targetSlotId, relation: relation.relation.trim() }
}

function incompleteIdentitySlot(index: number): never {
  throw new Error(`角色身份清单第 ${index + 1} 项字段不完整`)
}

function decodeIdentitySlot(candidate: unknown, index: number): CharacterIdentitySlot {
  if (!isRecord(candidate)) throw new Error(`角色身份清单第 ${index + 1} 项无效`)
  const relations = candidate.relations
  if (!Array.isArray(relations)) throw new Error(`角色身份清单第 ${index + 1} 项缺少关系列表`)
  const slotId = normalizeCharacterSlotId(candidate.slotId)
  if (slotId === undefined) incompleteIdentitySlot(index)
  if (typeof candidate.name !== 'string' || !candidate.name.trim()) incompleteIdentitySlot(index)
  if (typeof candidate.role !== 'string' || !CHARACTER_ROSTER_ROLES.includes(candidate.role as CharacterRosterEntry['role'])) {
    incompleteIdentitySlot(index)
  }
  if (typeof candidate.narrativeDuty !== 'string' || !candidate.narrativeDuty.trim()) incompleteIdentitySlot(index)
  return {
    slotId,
    name: candidate.name.trim(),
    role: candidate.role as CharacterRosterEntry['role'],
    narrativeDuty: candidate.narrativeDuty.trim(),
    relations: relations.map((relation, relationIndex) => (
      decodeIdentityRelation(relation, index, relationIndex)
    )),
  }
}

export function decodeCharacterIdentityManifest(content: string): CharacterIdentitySlot[] {
  const parsed = JSON.parse(extractSingleCompleteJsonObject(content)) as { slots?: unknown }
  if (!Array.isArray(parsed.slots)) throw new Error('角色身份清单缺少 slots')
  if (parsed.slots.length < MIN_CHARACTER_SLOTS || parsed.slots.length > MAX_CHARACTER_SLOTS) {
    throw new Error(`角色身份清单必须包含 ${MIN_CHARACTER_SLOTS}–${MAX_CHARACTER_SLOTS} 个角色`)
  }
  const slots = parsed.slots.map((candidate, index) => decodeIdentitySlot(candidate, index))
  const slotIds = new Set(slots.map(slot => slot.slotId))
  const names = new Set(slots.map(slot => slot.name))
  if (slotIds.size !== slots.length || names.size !== slots.length) throw new Error('角色身份清单包含重复 slotId 或姓名')
  if (!slots.some(slot => slot.role === 'protagonist')) throw new Error('角色身份清单必须至少包含一个主角')
  for (const slot of slots) {
    for (const relation of slot.relations) {
      if (!slotIds.has(relation.targetSlotId) || relation.targetSlotId === slot.slotId) {
        throw new Error('角色身份清单关系端点不闭合或存在自指')
      }
    }
  }
  return slots
}

function normalizeCharacterSlotId(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  return undefined
}

export function validateCharacterDetail(output: CharacterDetailOutput): string | undefined {
  let slotId = 'unknown'
  if (typeof output.slotId === 'string' && output.slotId.trim()) slotId = output.slotId.trim()
  const invalid = (field: string, reason: string) => `角色详情 slotId=${slotId} 字段 ${field} ${reason}`
  for (const field of [
    'slotId', 'name', 'gender', 'age', 'appearance', 'personality', 'background',
    'abilities', 'motivation', 'arc', 'notes',
  ] as const) {
    const value = output[field]
    if (typeof value !== 'string' || !value.trim()) return invalid(field, '必须是非空文本')
  }
  for (const field of CHARACTER_DETAIL_DESCRIPTION_FIELDS) {
    if (Array.from(output[field].trim()).length > CHARACTER_DETAIL_DESCRIPTION_MAX_CHARS) {
      return invalid(field, `不得超过 ${CHARACTER_DETAIL_DESCRIPTION_MAX_CHARS} 字符`)
    }
  }
  if (!CHARACTER_ROSTER_ROLES.includes(output.role)) return invalid('role', '不是允许的定位')
  if (output.relationships !== undefined) return invalid('relationships', '不得出现')
  if (output.currentState === undefined) return invalid('currentState', '必填')
  if (!isRecord(output.currentState)) return invalid('currentState', '必须是对象')
  for (const field of CHARACTER_STATE_TEXT_FIELDS) {
    const value = output.currentState[field]
    if (typeof value !== 'string' || !value.trim()) return invalid(`currentState.${field}`, '必须是非空文本')
    if (Array.from(value.trim()).length > CHARACTER_STATE_TEXT_MAX_CHARS) {
      return invalid(`currentState.${field}`, `不得超过 ${CHARACTER_STATE_TEXT_MAX_CHARS} 字符`)
    }
  }
  if (!Number.isSafeInteger(output.currentState.updatedAtChapter) || output.currentState.updatedAtChapter < 0) {
    return invalid('currentState.updatedAtChapter', '必须是非负整数')
  }
  return undefined
}

export function normalizeDetailStringList(value: unknown, separator: string): unknown {
  if (typeof value === 'string') return value.trim()
  if (!Array.isArray(value) || value.length === 0) return value
  const normalized: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) return value
    normalized.push(item.trim())
  }
  return normalized.join(separator)
}

export function normalizeBoundedDetailText(value: unknown, maxChars: number): unknown {
  if (typeof value !== 'string') return value
  return Array.from(value.trim()).slice(0, maxChars).join('')
}
