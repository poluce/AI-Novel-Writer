import type { ProjectCoreSynopsisExpected } from '../../../shared/contracts/project-core'
import type { WritingLanguage } from '../../../shared/writing-language'
import { promptLanguageText } from '../../prompt-language'

export type UiText = (zhCNText: string, enUSText: string) => string

export function plotOutlineBatchLog(
  mode: 'resume' | 'fresh' | 'batch',
  from: number,
  to: number,
  totalChapters: number,
): { zhCNText: string; enUSText: string } {
  if (to >= totalChapters) {
    if (mode === 'resume') {
      return {
        zhCNText: '情节大纲续写完成，全书大纲已就绪',
        enUSText: 'Plot-outline continuation complete; the full outline is ready.',
      }
    }
    return {
      zhCNText: '情节大纲已生成，全书大纲已就绪',
      enUSText: 'Plot outline generated; the full outline is ready.',
    }
  }
  if (mode === 'resume') {
    return {
      zhCNText: `第 ${from}–${to} 章续写完成；全书还剩第 ${to + 1} 章起待生成`,
      enUSText: `Batch chapters ${from}-${to} continued; chapters ${to + 1}+ are still pending.`,
    }
  }
  return {
    zhCNText: `第 ${from}–${to} 章已生成；全书还剩第 ${to + 1} 章起待生成`,
    enUSText: `Batch chapters ${from}-${to} generated; chapters ${to + 1}+ are still pending.`,
  }
}

export interface PartialArchData {
  premise_result?: string
  character_dynamics_result?: string
  character_state_result?: string
  world_building_result?: string
  /** 情节大纲：已确认覆盖至 synopsis_covered_to 的纯正文（不含批次进度行）。 */
  synopsis_result?: string
  /** 上一次生成在本批范围内被输出长度中断；synopsis_result 为已完成部分。 */
  synopsis_incomplete?: boolean
  /** 最近一次成功批次的结束章（== totalChapters 时全书大纲完成）。 */
  synopsis_covered_to?: number
  /** 当前/上次生成批次的范围；断点续写恢复时沿用。 */
  synopsis_range?: { from: number; to: number }
  /** 大纲赖以生成的源事实指纹；源事实变化后禁止续写旧检查点。 */
  synopsis_facts_fingerprint?: string
  /** 上次写入 DB 的大纲全文指纹；用于检测大纲是否被手动编辑（防续批覆盖用户修改）。 */
  synopsis_db_hash?: string
  /** 与 synopsis_result 精确绑定；旧检查点缺失时由 DB 逐字等价校验兼容。 */
  synopsis_body_hash?: string
  /** 本批实际使用的作者步骤指导；恢复必须沿用，不读取新输入。 */
  synopsis_step_guidance?: string
}

const SYNOPSIS_CHECKPOINT_FIELDS = [
  'synopsis_result',
  'synopsis_incomplete',
  'synopsis_covered_to',
  'synopsis_range',
  'synopsis_facts_fingerprint',
  'synopsis_db_hash',
  'synopsis_body_hash',
  'synopsis_step_guidance',
] as const satisfies readonly (keyof PartialArchData)[]

export function sameSynopsisCheckpoint(
  left: PartialArchData,
  right: PartialArchData,
): boolean {
  return SYNOPSIS_CHECKPOINT_FIELDS.every(field => (
    JSON.stringify(left[field]) === JSON.stringify(right[field])
  ))
}

export function restoreSynopsisCheckpoint(
  current: PartialArchData,
  previous: PartialArchData,
): PartialArchData {
  const restored = { ...current }
  for (const field of SYNOPSIS_CHECKPOINT_FIELDS) {
    Object.assign(restored, { [field]: previous[field] })
  }
  return restored
}

/** 大纲章节范围。 */
export interface PlotOutlineChapterRange {
  from: number
  to: number
}

/**
 * 情节大纲生成被输出长度中断、且已完成部分已自动保存时抛出的错误。
 * errorCode 供前端识别并展示「继续生成情节大纲」断点续写按钮。
 */
export const PLOT_OUTLINE_RESUME_ERROR_CODE = 'architecture-synopsis-resume-available'

export class PlotOutlineResumeAvailableError extends Error {
  readonly code = PLOT_OUTLINE_RESUME_ERROR_CODE

  constructor(message: string) {
    super(message)
    this.name = 'PlotOutlineResumeAvailableError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/** 少于该字符数视为无保存价值的零碎输出，不落盘、不提供续写。 */
export const MIN_SYNOPSIS_PARTIAL_PERSIST_CHARS = 120

/** 落库时追加在未完成大纲末尾的可见标记（帮助用户识别与编辑器提示）。 */
const SYNOPSIS_INCOMPLETE_MARKER_ZH = [
  '',
  '> ⚠️ **本大纲未完成**：生成被输出长度中断，以上为已自动保存的已完成部分。',
  '> 可在「AI 输出」提示处点击「继续生成情节大纲」，从断点续写补齐本批章节。',
  '',
].join('\n')

const SYNOPSIS_INCOMPLETE_MARKER_EN = [
  '',
  '> ⚠ **This outline is incomplete**: generation stopped at the output length limit; the completed part above was saved automatically.',
  '> Click “Continue plot outline” in the AI output notice to resume this batch.',
  '',
].join('\n')

/**
 * 批次进度行的双语模板，仅辅助定位本批范围。完整覆盖本批后可附上该行；
 * 缺少进度行不代表截断，附带时范围必须准确，完成判断仍以正文覆盖为准。
 */
function plotOutlineProgressLine(
  writingLanguage: WritingLanguage,
  from: number,
  to: number,
  totalChapters: number,
): string {
  return promptLanguageText(
    writingLanguage,
    `大纲批次进度：已覆盖第${from}–${to}章，全书共${totalChapters}章`,
    `[Outline batch progress: covered chapters ${from}-${to} of ${totalChapters}]`,
  )
}

interface PlotOutlineProgressMark {
  from: number
  to: number
  totalChapters: number
}

const ZH_PROGRESS_MARK_RE = /大纲批次进度：已覆盖第(\d+)[–—-](\d+)章，全书共(\d+)章/gu
const EN_PROGRESS_MARK_RE = /\[Outline batch progress: covered chapters (\d+)[\s-]+(\d+) of (\d+)\]/gu

function progressMarkFromMatch(match: RegExpMatchArray): PlotOutlineProgressMark | null {
  const from = Number(match[1])
  const to = Number(match[2])
  const totalChapters = Number(match[3])
  if (Number.isSafeInteger(from) && Number.isSafeInteger(to) && Number.isSafeInteger(totalChapters)) {
    return { from, to, totalChapters }
  }
  return null
}

function findPlotOutlineProgressMark(text: string): PlotOutlineProgressMark | null {
  for (const pattern of [ZH_PROGRESS_MARK_RE, EN_PROGRESS_MARK_RE]) {
    for (const match of text.matchAll(pattern)) {
      const mark = progressMarkFromMatch(match)
      if (mark) return mark
    }
  }
  return null
}

/** 从已确认正文中移除批次进度行（成功批次落盘前剔除）。 */
export function stripPlotOutlineProgressLine(text: string): string {
  return text
    .replace(ZH_PROGRESS_MARK_RE, '')
    .replace(EN_PROGRESS_MARK_RE, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

interface PlotOutlineTitleRange {
  from: number
  to: number
  index: number
  headingLineEnd: number
}

export class NonRecoverablePlotOutlineError extends Error {}

const CHINESE_CHAPTER_DIGITS: Readonly<Record<string, number>> = Object.freeze({
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9,
})
const CHINESE_CHAPTER_UNITS: Readonly<Record<string, number>> = Object.freeze({ 十: 10, 百: 100, 千: 1000 })
const CHAPTER_NUMBER_TOKEN = '[0-9零〇一二两三四五六七八九十百千]+'
const ZH_CHAPTER_TITLE_RE = new RegExp(
  `^[\\t ]*(?:#{1,6}[\\t ]+|[-*+][\\t ]+)?第(${CHAPTER_NUMBER_TOKEN})(?:[–—-](${CHAPTER_NUMBER_TOKEN}))?章(?=[\\t ]*(?:[:：.．—-]|$))`,
  'gmu',
)
const EN_CHAPTER_TITLE_RE = /^[\t ]*(?:#{1,6}[\t ]+|[-*+][\t ]+)?Chapters?[\t ]+(\d+)(?:[\t ]*[–—-][\t ]*(\d+))?(?=[\t ]*(?:[:.：—-]|$))/gimu

function parseChapterNumberToken(token: string): number | null {
  if (/^\d+$/u.test(token)) {
    const value = Number(token)
    return Number.isSafeInteger(value) ? value : null
  }
  let result = 0
  let digit = 0
  for (const char of token) {
    if (char in CHINESE_CHAPTER_DIGITS) {
      digit = CHINESE_CHAPTER_DIGITS[char]!
      continue
    }
    const unit = CHINESE_CHAPTER_UNITS[char]
    if (!unit) return null
    result += (digit || 1) * unit
    digit = 0
  }
  return result + digit
}

function findPlotOutlineTitleRanges(text: string): PlotOutlineTitleRange[] {
  const ranges: PlotOutlineTitleRange[] = []
  for (const regex of [ZH_CHAPTER_TITLE_RE, EN_CHAPTER_TITLE_RE]) {
    regex.lastIndex = 0
    for (const match of text.matchAll(regex)) {
      const from = parseChapterNumberToken(match[1]!)
      const to = parseChapterNumberToken(match[2] ?? match[1]!)
      if (from !== null && to !== null) {
        const index = match.index ?? 0
        const lineEnd = text.indexOf('\n', index)
        ranges.push({
          from,
          to,
          index,
          headingLineEnd: lineEnd < 0 ? text.length : lineEnd,
        })
      }
    }
  }
  return ranges.sort((left, right) => left.index - right.index)
}

export function assertPlotOutlineTitleCoverage(
  merged: string,
  seedText: string,
  from: number,
  to: number,
  uiText: UiText,
  allowIncompleteLastEntry = false,
): void {
  const seedPriorCounts = new Map<string, number>()
  for (const range of findPlotOutlineTitleRanges(seedText)) {
    if (range.to >= from) continue
    const key = `${range.from}:${range.to}`
    seedPriorCounts.set(key, (seedPriorCounts.get(key) ?? 0) + 1)
  }
  const covered = new Set<number>()
  const invalid: string[] = []
  const entries = findPlotOutlineTitleRanges(merged)
  let nextExpectedChapter = from
  for (const [index, range] of entries.entries()) {
    const key = `${range.from}:${range.to}`
    if (range.to < from) {
      const remaining = seedPriorCounts.get(key) ?? 0
      if (remaining > 0) seedPriorCounts.set(key, remaining - 1)
      else invalid.push(`${range.from}-${range.to}`)
      continue
    }
    if (range.from < from || range.to > to || range.from > range.to) {
      invalid.push(`${range.from}-${range.to}`)
      continue
    }
    if (range.from !== nextExpectedChapter) invalid.push(`${range.from}-${range.to}`)
    nextExpectedChapter = Math.max(nextExpectedChapter, range.to + 1)
    const nextHeadingIndex = entries[index + 1]?.index ?? merged.length
    const entryBody = stripPlotOutlineProgressLine(
      merged.slice(Math.min(range.headingLineEnd + 1, merged.length), nextHeadingIndex),
    ).trim()
    if (!entryBody && !(allowIncompleteLastEntry && index === entries.length - 1)) {
      invalid.push(`${range.from}-${range.to}:empty`)
    }
    for (let chapter = range.from; chapter <= range.to; chapter += 1) {
      if (covered.has(chapter)) invalid.push(String(chapter))
      covered.add(chapter)
    }
  }
  const missing: number[] = []
  for (let chapter = from; chapter <= to; chapter += 1) {
    if (!covered.has(chapter)) missing.push(chapter)
  }
  if (invalid.length > 0 || missing.length > 0) {
    const message = uiText(
      `大纲正文未按顺序提供本批第 ${from}–${to} 章的非空条目（缺失 ${missing.length} 章，空白、重复、乱序或越界 ${invalid.length} 处），结果未按完成保存。`,
      `The outline body does not provide non-empty entries in order for batch chapters ${from}-${to} (${missing.length} missing; ${invalid.length} empty, duplicate, out of order, or out of range), so the result was not saved as complete.`,
    )
    if (invalid.length > 0) {
      throw new NonRecoverablePlotOutlineError(uiText(
        `${message} 完整模型输出仍保留在 AI 输出中，但这种结构错误不能自动续写；请修正范围后重新生成。`,
        `${message} The complete model output remains visible in AI output, but this structural error cannot be continued automatically; correct the range and regenerate.`,
      ))
    }
    throw new Error(message)
  }
}

/** 轻量确定性指纹：绑定大纲赖以生成的源事实，防止旧检查点被续到新上下文。 */
export function synopsisFactsFingerprint(facts: readonly string[]): string {
  const joined = facts.join('\u0001')
  let hash = 5381
  for (let index = 0; index < joined.length; index += 1) {
    hash = ((hash << 5) + hash + joined.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}

export function renderSynopsisDbText(
  body: string,
  writingLanguage: WritingLanguage,
  totalChapters: number,
  checkpoint: Pick<PartialArchData, 'synopsis_incomplete' | 'synopsis_covered_to'>,
): string {
  const heading = promptLanguageText(writingLanguage, '情节大纲', 'Plot Outline')
  if (checkpoint.synopsis_incomplete === true) {
    const marker = promptLanguageText(
      writingLanguage,
      SYNOPSIS_INCOMPLETE_MARKER_ZH,
      SYNOPSIS_INCOMPLETE_MARKER_EN,
    )
    return `# ${heading}\n\n${body}\n${marker}`.trim()
  }
  const coveredTo = checkpoint.synopsis_covered_to ?? totalChapters
  const visibleBody = coveredTo < totalChapters
    ? `${body}\n\n${promptLanguageText(
        writingLanguage,
        `> 本大纲已覆盖至第 ${coveredTo} 章（全书 ${totalChapters} 章），其余章节将在后续批次继续生成。`,
        `> This outline covers chapters 1-${coveredTo} of ${totalChapters}; the remaining chapters will be generated in later batches.`,
      )}`
    : body
  return `# ${heading}\n\n${visibleBody}`.trim()
}

export function synopsisInputsFingerprint(
  expected: ProjectCoreSynopsisExpected,
  stepGuidance: string,
  range: PlotOutlineChapterRange,
  template: unknown,
): string {
  const sourceInputs = {
    premise: expected.premise,
    charactersArch: expected.charactersArch,
    worldbuilding: expected.worldbuilding,
    genre: expected.genre,
    totalChapters: expected.totalChapters,
    wordsPerChapter: expected.wordsPerChapter,
    writingLanguage: expected.writingLanguage,
    plotStructure: expected.plotStructure,
    narrativePov: expected.narrativePov,
    globalGuidance: expected.globalGuidance,
  }
  return synopsisFactsFingerprint([
    JSON.stringify(sourceInputs),
    stepGuidance,
    `${range.from}:${range.to}`,
    JSON.stringify(template),
  ])
}

/**
 * 「本批生成范围」指令：批次可任意处于第 from–to 章。当 from > 1 时模型
 * 必须从已有前缀（seed）末尾自然衔接继续写；to < total 时剩余章节只允许
 * 一行占位概览，等待后续批次补齐。
 */
export function synopsisBatchInstruction(
  writingLanguage: WritingLanguage,
  from: number,
  to: number,
  totalChapters: number,
): string {
  const leading = from > 1
    ? promptLanguageText(
        writingLanguage,
        `第 1–${from - 1} 章的大纲已在【已完成大纲前缀】中给出：不得重复、改写或复述该前缀；从第 ${from} 章起自然衔接继续书写。`,
        `Chapters 1-${from - 1} are already covered in the [confirmed outline prefix]: do not repeat, rewrite, or restate it; continue naturally from chapter ${from}.`,
      )
    : ''
  const trailing = to < totalChapters
    ? promptLanguageText(
        writingLanguage,
        `第 ${to + 1}–${totalChapters} 章本次不展开细写：只写一行“后续概览：……”概览整段走向（不超过 200 字），等待后续批次继续生成。该行不得使用“第N章”或“第N–M章”标题，也不计入本批覆盖。`,
        `Chapters ${to + 1}-${totalChapters} must not be expanded in this batch: write one short “Later overview: ...” line (200 characters or fewer) for that future span. Do not title it “Chapter N” or “Chapters N-M”; it does not count toward this batch's coverage.`,
      )
    : ''
  const contract = [
    leading,
    promptLanguageText(
      writingLanguage,
      `【本次生成范围（重要）】\n本次必须对第 ${from}–${to} 章输出完整详细的情节大纲（全书共 ${totalChapters} 章）。每章或连续章组必须以独立行标题开头，严格使用“第N章：标题”或“第N–M章：标题”格式，并在标题下一行起写非空正文。`,
      `[Generation scope for this batch (important)]\nDetail complete plot outline entries for chapters ${from}-${to} of ${totalChapters}. Start every chapter or consecutive chapter group with its own heading, strictly formatted as “Chapter N: Title” or “Chapters N-M: Title”, then write a non-empty body beginning on the next line.`,
    ),
    trailing,
    promptLanguageText(
      writingLanguage,
      `【批次收尾（辅助信息）】完整覆盖第 ${from}–${to} 章后，可在最后一行附上以下进度（如附上，范围必须准确）：${plotOutlineProgressLine(writingLanguage, from, to, totalChapters)}`,
      `[Batch completion line (supporting information)] After fully covering chapters ${from}-${to}, you may append this progress line; if included, its range must be exact: ${plotOutlineProgressLine(writingLanguage, from, to, totalChapters)}`,
    ),
  ].filter(Boolean).join('\n\n')
  return contract
}

/** 正常结束后以正文覆盖为准；可选自报进度不能与本批冲突。 */
export function assertPlotOutlineBatchComplete(
  merged: string,
  from: number,
  to: number,
  totalChapters: number,
  uiText: UiText,
): void {
  const mark = findPlotOutlineProgressMark(merged)
  if (!mark && !merged.includes('大纲批次进度') && !merged.includes('[Outline batch progress:')) return
  if (!mark
    || mark.from !== from
    || mark.to !== to
    || mark.totalChapters !== totalChapters
  ) {
    throw new Error(uiText(
      `大纲输出包含无效的批次完成标记（需要与本批范围完全一致：第 ${from}–${to} 章、全书 ${totalChapters} 章），`
        + '批次范围可能错位，结果未按完成保存。',
      `The outline output contains an invalid batch-completion marker (expected chapters ${from}-${to} of ${totalChapters}); `
        + 'its range may be incorrect, so it was not saved as complete.',
    ))
  }
}

/**
 * 续批/恢复前校验 DB 中的大纲是否仍是上次生成写入的内容。用户可能直接在
 * 编辑器手动修改大纲（保存只更新 DB）：此时若按检查点前缀拼接会覆盖用户的
 * 修改，必须 fail-closed 并引导显式重新生成。
 */
export function assertCheckpointDbMirrorCurrent(
  partial: PartialArchData,
  dbOutlineText: string,
  writingLanguage: WritingLanguage,
  totalChapters: number,
  uiText: UiText,
): string {
  const range = partial.synopsis_range
  const coveredTo = partial.synopsis_covered_to ?? 0
  if (!range
    || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to)
    || range.from < 1 || range.from > range.to || range.to > totalChapters
    || !Number.isSafeInteger(coveredTo) || coveredTo < 0 || coveredTo > totalChapters
    || (partial.synopsis_incomplete !== true && coveredTo !== range.to)
    || (partial.synopsis_incomplete === true && coveredTo >= range.to)
  ) {
    throw new Error(uiText(
      '情节大纲检查点的章节范围或进度已损坏，无法安全续写。请从第 1 章重新生成。',
      'The plot-outline checkpoint has a damaged range or progress value and cannot be continued safely. Regenerate from chapter 1.',
    ))
  }
  const checkpointBody = typeof partial.synopsis_result === 'string'
    ? partial.synopsis_result.trim()
    : ''
  if (!checkpointBody) {
    throw new Error(uiText(
      '情节大纲检查点缺少正文，无法安全续写。请从第 1 章重新生成。',
      'The plot-outline checkpoint has no body and cannot be continued safely. Regenerate from chapter 1.',
    ))
  }
  const dbOutlineHash = synopsisFactsFingerprint([dbOutlineText])
  const recordedHash = partial.synopsis_db_hash
  if (recordedHash === undefined) {
    throw new Error(uiText(
      '续批检查点没有数据库镜像指纹，无法确认大纲未被手动修改。请从「AI 生成故事架构」从第 1 章重新生成大纲。',
      'The continuation checkpoint has no database-mirror fingerprint, so we cannot confirm the outline was not edited by hand. Regenerate the outline from chapter 1 in “Generate story architecture”.',
    ))
  }
  if (recordedHash !== dbOutlineHash) {
    throw new Error(uiText(
      '情节大纲正文在上次生成后已被手动修改，续批会覆盖这些修改，已拒绝。'
        + '如需保留修改，请基于修改后的正文从第 1 章重新生成；若该修改有误，请先撤销后再续批。',
      'The outline body was manually edited after the last generation; continuing would overwrite those edits, so it was rejected. '
        + 'To keep the edits, regenerate from chapter 1 on top of them; if the edit was a mistake, revert it before continuing.',
    ))
  }
  if (renderSynopsisDbText(checkpointBody, writingLanguage, totalChapters, partial) !== dbOutlineText
    || (partial.synopsis_body_hash !== undefined
      && partial.synopsis_body_hash !== synopsisFactsFingerprint([checkpointBody]))
  ) {
    throw new Error(uiText(
      '情节大纲检查点正文与数据库原文不一致，无法安全续写。数据库正文未被覆盖。',
      'The plot-outline checkpoint body does not exactly match the database source. The database outline was not overwritten.',
    ))
  }
  return checkpointBody
}

export function hasVisibleIncompleteSynopsisMarker(dbOutlineText: string): boolean {
  return dbOutlineText.includes('本大纲未完成')
    || dbOutlineText.includes('This outline is incomplete')
}

export function hasVisiblePartialSynopsisMarker(dbOutlineText: string): boolean {
  return hasVisibleIncompleteSynopsisMarker(dbOutlineText)
    || dbOutlineText.includes('本大纲已覆盖至第')
    || dbOutlineText.includes('This outline covers chapters')
}

export function isUsableSynopsisCheckpoint(
  value: unknown,
  dbOutlineText: string,
  writingLanguage: WritingLanguage,
  totalChapters: number,
): boolean {
  if (!value || typeof value !== 'object') return false
  const partial = value as PartialArchData
  try {
    return assertCheckpointDbMirrorCurrent(
      partial,
      dbOutlineText,
      writingLanguage,
      totalChapters,
      (zhCNText) => zhCNText,
    ).length >= MIN_SYNOPSIS_PARTIAL_PERSIST_CHARS
  } catch {
    return false
  }
}

export function isRecoverableSynopsisCheckpoint(
  value: unknown,
  dbOutlineText: string,
  writingLanguage: WritingLanguage,
  totalChapters: number,
): boolean {
  return Boolean((value as PartialArchData | null)?.synopsis_incomplete)
    && isUsableSynopsisCheckpoint(value, dbOutlineText, writingLanguage, totalChapters)
}
