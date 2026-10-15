import { createHash } from 'node:crypto'
import { getProjectDb } from '../database'
import {
  parseImportRunChapterBatchCheckpointId,
  IMPORT_RUN_BLUEPRINT_BATCH_SIZE,
  IMPORT_RUN_KNOWLEDGE_BATCH_SIZE,
} from '../../src/shared/import-run'
import type {
  ImportPurpose,
  ImportRunChapterInput,
  ImportRunChapterSnapshot,
  ImportRunEffectKind,
  ImportRunSnapshot,
  ImportRunStage,
  ImportRunStatus,
  ImportRunExecutionAuthority,
  ImportRunExecutionLease,
  ImportSourceDisplayMetadata,
} from '../../src/shared/import-run'
import { MAX_IMPORT_SOURCE_FILES } from '../../src/shared/import-limits'
import { parseJson, SHA256 } from './import-run-schema'

export interface ImportRunRow {
  id: string
  purpose: ImportPurpose
  root_run_id: string
  effect_namespace: string
  source_fingerprint: string
  manifest_fingerprint: string
  authority_fingerprint: string
  legacy_source_fingerprint: string
  source_display_json: string
  locale: 'zh-CN' | 'en-US'
  stage: ImportRunStage
  status: ImportRunStatus
  completed_batches_json: string
  last_error: string
  resumable: number
  cancel_requested: number
  execution_owner: string
  execution_epoch: number
  lease_expires_at: number
  total_chapters: number
  total_content_size: number
  manifest_chapter_count: number
  manifest_content_size: number
  manifest_word_count: number
  completed_chapters: number
  base_run_id: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface ImportRunChapterRow {
  chapter_number: number
  source_id: string
  source_chapter_number: number
  title: string
  content_fingerprint: string
  content_size: number
  content_snapshot: string
}

export interface ImportRunCheckpointChapterRow {
  chapter_number: number
  content_fingerprint: string
}

export interface NormalizedImportRunChapter extends ImportRunChapterInput {
  sourceId: string
  sourceChapterNumber: number
}

export interface ImportRunEffectReceiptRow {
  run_id: string
  schema_version: number
  effect_namespace: string
  effect_key: string
  stage: ImportRunStage
  batch_id: string
  kind: ImportRunEffectKind
  payload_json: string
  payload_hash: string
  state: 'prepared' | 'committed'
  effect_receipt_json: string | null
  created_at: string
  updated_at: string
}

export interface ImportRunSourceRow {
  run_id: string
  source_index: number
  source_id: string
  source_fingerprint: string
  legacy_source_fingerprint: string
  display_json: string
  status: 'pending' | 'completed' | 'failed'
  manifest_fingerprint: string
  chapter_count: number
  content_size: number
  word_count: number
  last_error: string
}


export const OPAQUE_SOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export const MAX_CHAPTER_BYTES = 16 * 1024 * 1024

export const MAX_PAGE_SIZE = 100

export const INSERT_BATCH_SIZE = 50

export const MAX_DISPLAY_SOURCES = MAX_IMPORT_SOURCE_FILES

export const AUTHOR_CHAPTER_CHECKPOINT = /^chapter:([1-9]\d*)$/u

export const IMPORT_RUN_STAGE_VALUES = new Set<ImportRunStage>([
  'parsing', 'prepared', 'knowledge', 'global', 'style', 'blueprints',
  'author-commit', 'author-publish', 'author-postprocess',
  'refresh', 'completed',
])

export type ImportRunCheckpointSource = 'direct' | 'receipt'

export function db() {
  const current = getProjectDb()
  if (!current) throw new Error('项目数据库未打开')
  return current
}

export function sourceProgress(runId: string): { completedSources: number; totalSources: number; completedChapters: number } {
  const progress = db().prepare(`
    SELECT COUNT(*) AS total_sources,
           COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_sources,
           COALESCE(SUM(CASE WHEN status = 'completed' THEN chapter_count ELSE 0 END), 0) AS completed_chapters
    FROM import_run_sources WHERE run_id = ?
  `).get(runId) as { total_sources: number; completed_sources: number; completed_chapters: number }
  return {
    totalSources: progress.total_sources,
    completedSources: progress.completed_sources,
    completedChapters: progress.completed_chapters,
  }
}

export function unfinishedSourceDisplay(runId: string): ImportSourceDisplayMetadata[] {
  const rows = db().prepare(`
    SELECT display_json
    FROM import_run_sources
    WHERE run_id = ? AND status <> 'completed'
    ORDER BY source_index
  `).all(runId) as Array<{ display_json: string }>
  return rows.map(row => parseJson<ImportSourceDisplayMetadata>(
    row.display_json,
    { displayName: '', mediaType: '', size: 0 },
  ))
}

export function completedChaptersForStage(row: ImportRunRow): number {
  if (row.stage === 'prepared') return 0
  if (row.stage === 'knowledge') return completedCheckpointChapters(row, 'knowledge')
  return row.total_chapters
}

export function completedCheckpointChapters(row: ImportRunRow, stage: 'knowledge' | 'blueprints'): number {
  const covered = new Set<number>()
  for (const batchId of completedBatches(row)[stage] ?? []) {
    for (const chapterNumber of checkpointChapterNumbers(row, stage, batchId)) covered.add(chapterNumber)
  }
  return covered.size
}

export function persistedProgress(row: ImportRunRow): {
  completedSources: number
  totalSources: number
  completedChapters: number
  progressCompleted: number
  progressTotal: number
} {
  const sources = sourceProgress(row.id)
  if (row.stage === 'parsing') {
    return {
      ...sources,
      progressCompleted: sources.completedSources,
      progressTotal: sources.totalSources,
    }
  }
  const completedChapters = completedChaptersForStage(row)
  if (row.stage === 'knowledge' || row.stage === 'prepared') {
    return {
      ...sources,
      completedChapters,
      progressCompleted: completedChapters,
      progressTotal: row.total_chapters,
    }
  }
  if (row.stage === 'blueprints') {
    return {
      ...sources,
      completedChapters,
      progressCompleted: completedCheckpointChapters(row, 'blueprints'),
      progressTotal: row.total_chapters,
    }
  }
  if (row.stage === 'global' || row.stage === 'style' || row.stage === 'refresh') {
    return {
      ...sources,
      completedChapters,
      progressCompleted: completedBatches(row)[row.stage]?.includes('done') ? 1 : 0,
      progressTotal: 1,
    }
  }
  return {
    ...sources,
    completedChapters,
    progressCompleted: row.total_chapters,
    progressTotal: row.total_chapters,
  }
}

export function rowToSnapshot(row: ImportRunRow): ImportRunSnapshot {
  const progress = persistedProgress(row)
  const snapshot: ImportRunSnapshot = {
    id: row.id,
    purpose: row.purpose,
    rootRunId: row.root_run_id,
    effectNamespace: row.effect_namespace,
    sourceDisplay: parseJson<ImportSourceDisplayMetadata[]>(row.source_display_json, []),
    unfinishedSourceDisplay: unfinishedSourceDisplay(row.id),
    locale: row.locale,
    stage: row.stage,
    status: row.status,
    completedBatches: parseJson(row.completed_batches_json, {}),
    lastError: row.last_error,
    resumable: row.resumable === 1,
    cancelRequested: row.cancel_requested === 1,
    totalChapters: row.total_chapters,
    totalContentSize: row.total_content_size,
    manifestChapterCount: row.manifest_chapter_count,
    manifestContentSize: row.manifest_content_size,
    manifestWordCount: row.manifest_word_count,
    completedChapters: progress.completedChapters,
    completedSources: progress.completedSources,
    totalSources: progress.totalSources,
    progressCompleted: progress.progressCompleted,
    progressTotal: progress.progressTotal,
    baseRunId: row.base_run_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  }
  if (row.purpose === 'author-manuscript') {
    snapshot.manifestFingerprint = row.manifest_fingerprint
    if (row.authority_fingerprint) snapshot.authorityFingerprint = row.authority_fingerprint
  }
  return snapshot
}

export function chapterRowToSnapshot(row: ImportRunChapterRow): ImportRunChapterSnapshot {
  assertFrozenChapterSnapshot(row)
  return {
    number: row.chapter_number,
    title: row.title,
    contentFingerprint: row.content_fingerprint,
    contentSize: row.content_size,
    content: row.content_snapshot,
  }
}

export function assertFrozenChapterSnapshot(row: Pick<
  ImportRunChapterRow,
  'content_fingerprint' | 'content_size' | 'content_snapshot'
>): void {
  const actualSize = Buffer.byteLength(row.content_snapshot, 'utf8')
  const actualFingerprint = createHash('sha256').update(row.content_snapshot, 'utf8').digest('hex')
  if (
    !Number.isSafeInteger(row.content_size)
    || row.content_size < 1
    || row.content_size > MAX_CHAPTER_BYTES
    || actualSize !== row.content_size
    || !SHA256.test(row.content_fingerprint)
    || actualFingerprint !== row.content_fingerprint
  ) throw new Error('导入冻结章节快照损坏，已拒绝继续')
}

export function readRunRow(runId: string): ImportRunRow | undefined {
  return db().prepare('SELECT * FROM import_runs WHERE id = ?').get(runId) as ImportRunRow | undefined
}

export function assertExecutionAuthority(
  runId: string,
  authority: ImportRunExecutionAuthority,
  now = Date.now(),
): ImportRunRow {
  const row = readRunRow(runId)
  if (
    !row
    || row.status !== 'running'
    || typeof authority?.owner !== 'string'
    || !authority.owner
    || !Number.isSafeInteger(authority.epoch)
    || row.execution_owner !== authority.owner
    || row.execution_epoch !== authority.epoch
    || row.lease_expires_at <= now
  ) throw new Error('导入执行租约已失效，已拒绝旧执行器写入')
  return row
}

export function completedBatches(row: ImportRunRow): Partial<Record<ImportRunStage, string[]>> {
  const parsed = parseJson<unknown>(row.completed_batches_json, null)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('导入运行 checkpoint 损坏')
  }
  for (const [stage, batches] of Object.entries(parsed)) {
    if (!IMPORT_RUN_STAGE_VALUES.has(stage as ImportRunStage)) {
      throw new Error('导入运行 checkpoint 损坏')
    }
    if (!Array.isArray(batches) || batches.some(batch => typeof batch !== 'string')) {
      throw new Error('导入运行 checkpoint 损坏')
    }
  }
  return parsed as Partial<Record<ImportRunStage, string[]>>
}

export function chapterRowsForRange(
  runId: string,
  startChapter: number,
  endChapter: number,
): ImportRunCheckpointChapterRow[] {
  return db().prepare(`
    SELECT chapter_number, content_fingerprint
    FROM import_run_chapters
    WHERE run_id = ? AND chapter_number BETWEEN ? AND ?
    ORDER BY chapter_number ASC
  `).all(runId, startChapter, endChapter) as ImportRunCheckpointChapterRow[]
}

export function checkpointRange(batchId: string): { startChapter: number; endChapter: number } {
  const parsed = parseImportRunChapterBatchCheckpointId(batchId)
  if (!parsed) throw new Error('导入批次 ID 无效')
  return parsed
}

export function checkpointChapterNumbers(row: ImportRunRow, stage: 'knowledge' | 'blueprints', batchId: string): number[] {
  if (stage === 'knowledge') {
    const parsed = parseImportRunChapterBatchCheckpointId(batchId)
    if (!parsed || parsed.contentFingerprintPrefixes.length > IMPORT_RUN_KNOWLEDGE_BATCH_SIZE) {
      throw new Error('导入批次 ID 无效')
    }
    const chapters = chapterRowsForRange(row.id, parsed.startChapter, parsed.endChapter)
    if (
      chapters.length !== parsed.contentFingerprintPrefixes.length
      || chapters.some((chapter, index) => (
        chapter.chapter_number !== parsed.startChapter + index
        || !chapter.content_fingerprint.startsWith(parsed.contentFingerprintPrefixes[index]!)
      ))
    ) throw new Error('导入批次 ID 无效')
    const receipts = db().prepare(`
      SELECT chapter_number, purpose, source_id, source_chapter_number,
             content_fingerprint, document_id, state
      FROM import_run_knowledge_receipts
      WHERE run_id = ? AND chapter_number BETWEEN ? AND ?
      ORDER BY chapter_number ASC
    `).all(row.id, parsed.startChapter, parsed.endChapter) as Array<{
      chapter_number: number
      purpose: string
      source_id: string
      source_chapter_number: number
      content_fingerprint: string
      document_id: string
      state: string
    }>
    const affiliations = db().prepare(`
      SELECT chapter_number, source_id, source_chapter_number, content_fingerprint
      FROM import_run_chapters
      WHERE run_id = ? AND chapter_number BETWEEN ? AND ?
      ORDER BY chapter_number ASC
    `).all(row.id, parsed.startChapter, parsed.endChapter) as Array<{
      chapter_number: number
      source_id: string
      source_chapter_number: number
      content_fingerprint: string
    }>
    if (receipts.length !== affiliations.length || receipts.some((receipt, index) => {
      const affiliation = affiliations[index]!
      return receipt.chapter_number !== affiliation.chapter_number
        || receipt.purpose !== row.purpose
        || receipt.source_id !== affiliation.source_id
        || receipt.source_chapter_number !== affiliation.source_chapter_number
        || receipt.content_fingerprint !== affiliation.content_fingerprint
        || !SHA256.test(receipt.document_id)
        || receipt.state !== 'committed'
    })) throw new Error('参照知识 receipt 未完成或与冻结章节不匹配')
    return chapters.map(chapter => chapter.chapter_number)
  }

  const parsed = parseImportRunChapterBatchCheckpointId(batchId)
  if (!parsed || parsed.contentFingerprintPrefixes.length > IMPORT_RUN_BLUEPRINT_BATCH_SIZE) {
    throw new Error('导入批次 ID 无效')
  }
  const chapters = chapterRowsForRange(row.id, parsed.startChapter, parsed.endChapter)
  if (
    chapters.length !== parsed.contentFingerprintPrefixes.length
    || chapters.some((chapter, index) => (
      chapter.chapter_number !== parsed.startChapter + index
      || !chapter.content_fingerprint.startsWith(parsed.contentFingerprintPrefixes[index]!)
    ))
  ) throw new Error('导入批次 ID 无效')
  return chapters.map(chapter => chapter.chapter_number)
}

export function authorCheckpointChapterNumber(row: ImportRunRow, batchId: string): number {
  const match = AUTHOR_CHAPTER_CHECKPOINT.exec(batchId)
  const chapterNumber = match ? Number(match[1]) : 0
  if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1) throw new Error('原稿导入批次 ID 无效')
  const chapter = db().prepare(`
    SELECT chapter_number FROM import_run_chapters WHERE run_id = ? AND chapter_number = ?
  `).get(row.id, chapterNumber) as { chapter_number: number } | undefined
  if (!chapter) throw new Error('原稿导入批次 ID 无效')
  return chapterNumber
}

export function assertCheckpointCanApply(
  row: ImportRunRow,
  stage: ImportRunStage,
  batchId: string,
  source: ImportRunCheckpointSource,
): void {
  if (row.status !== 'running' || row.stage !== stage) throw new Error('导入批次与当前阶段不匹配')
  if (stage === 'parsing' || stage === 'prepared' || stage === 'completed') throw new Error('导入批次 ID 无效')
  const receiptStage = stage === 'global'
    || stage === 'style'
    || stage === 'blueprints'
    || stage === 'author-commit'
  if ((receiptStage && source !== 'receipt') || (!receiptStage && source !== 'direct')) {
    throw new Error(receiptStage ? '该导入阶段必须通过 receipt 提交' : '该导入阶段不接受 receipt 提交')
  }
  if (stage === 'global' || stage === 'style' || stage === 'author-commit' || stage === 'refresh') {
    if (batchId !== 'done') throw new Error('导入批次 ID 无效')
    return
  }

  if (stage === 'author-publish' || stage === 'author-postprocess') {
    const chapterNumber = authorCheckpointChapterNumber(row, batchId)
    const existing = completedBatches(row)[stage] ?? []
    if (existing.some(existingBatchId => (
      existingBatchId !== batchId
      && authorCheckpointChapterNumber(row, existingBatchId) === chapterNumber
    ))) throw new Error('原稿导入批次与已完成 checkpoint 重叠')
    return
  }
  if (stage !== 'knowledge' && stage !== 'blueprints') throw new Error('导入批次 ID 无效')
  checkpointChapterNumbers(row, stage, batchId)
  const range = checkpointRange(batchId)
  const existing = completedBatches(row)[stage] ?? []
  for (const existingBatchId of existing) {
    if (existingBatchId === batchId) continue
    const existingRange = checkpointRange(existingBatchId)
    if (range.startChapter <= existingRange.endChapter && existingRange.startChapter <= range.endChapter) {
      throw new Error('导入批次与已完成 checkpoint 重叠')
    }
  }
}

export function assertStageCheckpointComplete(row: ImportRunRow, stage: ImportRunStage): void {
  const batches = completedBatches(row)[stage] ?? []
  if (stage === 'global' || stage === 'style' || stage === 'author-commit' || stage === 'refresh') {
    if (batches.length !== 1 || batches[0] !== 'done') throw new Error('导入阶段 checkpoint 未完成')
    return
  }
  if (stage === 'author-publish' || stage === 'author-postprocess') {
    const allChapters = chapterRowsForRange(row.id, 1, Number.MAX_SAFE_INTEGER)
    const covered = new Set(batches.map(batchId => authorCheckpointChapterNumber(row, batchId)))
    if (
      covered.size !== allChapters.length
      || allChapters.some(chapter => !covered.has(chapter.chapter_number))
    ) throw new Error('原稿导入阶段 checkpoint 未完成')
    return
  }
  if (stage !== 'knowledge' && stage !== 'blueprints') throw new Error('导入阶段 checkpoint 未完成')

  const allChapters = chapterRowsForRange(row.id, 1, Number.MAX_SAFE_INTEGER)
  const covered = new Set<number>()
  for (const batchId of batches) {
    for (const chapterNumber of checkpointChapterNumbers(row, stage, batchId)) {
      if (covered.has(chapterNumber)) throw new Error('导入阶段 checkpoint 重叠')
      covered.add(chapterNumber)
    }
  }
  if (
    covered.size !== allChapters.length
    || allChapters.some(chapter => !covered.has(chapter.chapter_number))
  ) throw new Error('导入阶段 checkpoint 未完成')
}

export function assertExecution(runId: string, execution: ImportRunExecutionLease, now = Date.now()): ImportRunRow {
  const row = assertExecutionAuthority(runId, execution, now)
  if (row.lease_expires_at !== execution.expiresAt) {
    throw new Error('导入执行租约已失效，已拒绝旧执行器写入')
  }
  return row
}

export function applyBatchCheckpoint(
  row: ImportRunRow,
  stage: ImportRunStage,
  batchId: string,
  source: ImportRunCheckpointSource,
): { newlyCompleted: boolean; cancelApplied: boolean } {
  assertCheckpointCanApply(row, stage, batchId, source)
  const completed = completedBatches(row)
  const stageBatches = completed[stage] ?? []
  const newlyCompleted = !stageBatches.includes(batchId)
  if (newlyCompleted) completed[stage] = [...stageBatches, batchId]
  const cancelApplied = row.cancel_requested === 1
  db().prepare(`
    UPDATE import_runs
    SET completed_batches_json = ?,
        status = CASE WHEN ? = 1 THEN 'cancelled' ELSE status END,
        resumable = 1,
        execution_owner = CASE WHEN ? = 1 THEN '' ELSE execution_owner END,
        execution_epoch = execution_epoch + CASE WHEN ? = 1 THEN 1 ELSE 0 END,
        lease_expires_at = CASE WHEN ? = 1 THEN 0 ELSE lease_expires_at END,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    JSON.stringify(completed),
    cancelApplied ? 1 : 0,
    cancelApplied ? 1 : 0,
    cancelApplied ? 1 : 0,
    cancelApplied ? 1 : 0,
    row.id,
  )
  return { newlyCompleted, cancelApplied }
}

export function getRun(runId: string): ImportRunSnapshot | null {
    const row = readRunRow(runId)
    return row ? rowToSnapshot(row) : null
  }

export function listResumable(): ImportRunSnapshot[] {
    const rows = db().prepare(`
      SELECT * FROM import_runs
      WHERE resumable = 1 AND status IN ('ready', 'running', 'failed', 'cancelled')
      ORDER BY updated_at DESC, rowid DESC
    `).all() as ImportRunRow[]
    return rows.map(rowToSnapshot)
  }

export function listChapterBatch(
    runId: string,
    options: { afterChapterNumber: number; limit: number },
  ): ImportRunChapterSnapshot[] {
    const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(options.limit)))
    const rows = db().prepare(`
      SELECT chapter_number, source_id, source_chapter_number,
             title, content_fingerprint, content_size, content_snapshot
      FROM import_run_chapters
      WHERE run_id = ? AND chapter_number > ?
      ORDER BY chapter_number ASC LIMIT ?
    `).all(runId, options.afterChapterNumber, limit) as ImportRunChapterRow[]
    return rows.map(chapterRowToSnapshot)
  }
