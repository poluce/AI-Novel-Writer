import { createHash } from 'node:crypto'
import { countDraftUnits } from '../../src/shared/draft-units'
import { AuthorImportPreviewStaleError } from '../../src/shared/import-run'
import type {
  ImportPurpose,
  ImportRunBeginParsingRequest,
  ImportRunChapterInput,
  ImportRunPreparationInspection,
  ImportRunPreparationResult,
  ImportRunPrepareRequest,
  ImportRunSnapshot,
  ImportSourceDisplayMetadata,
} from '../../src/shared/import-run'
import {
  MAX_IMPORT_CHAPTERS,
  MAX_IMPORT_SOURCE_FILES,
  MAX_IMPORT_TOTAL_BYTES,
} from '../../src/shared/import-limits'
import { FinalizedDraftImportRepository } from './finalized-draft-import-repository'
import { hashManifest, parseJson, SHA256 } from './import-run-schema'
import { rowToEffectReceipt } from './import-run-effects'
import {
  db,
  getRun,
  rowToSnapshot,
  readRunRow,
  MAX_DISPLAY_SOURCES,
  OPAQUE_SOURCE_ID,
  MAX_CHAPTER_BYTES,
  INSERT_BATCH_SIZE,
  type ImportRunRow,
  type ImportRunEffectReceiptRow,
  type ImportRunSourceRow,
  type NormalizedImportRunChapter,
} from './import-run-store'

export const IMPORT_PREPARATION_PREVIEW_LIMIT = 8

export function createPreparationInspection(
  inspectionId: string,
  purpose: ImportPurpose,
  sourceDisplay: readonly ImportSourceDisplayMetadata[],
  chapters: readonly { number: number; title: string; wordCount: number; contentSize: number }[],
  classification: Pick<
    ImportRunPreparationResult,
    'newChapterNumbers' | 'conflictChapterNumbers' | 'duplicateChapterNumbers'
  >,
): ImportRunPreparationInspection {
  const conflicts = new Set(classification.conflictChapterNumbers)
  const duplicates = new Set(classification.duplicateChapterNumbers)
  const fresh = new Set(classification.newChapterNumbers)
  const preview = chapters.slice(0, IMPORT_PREPARATION_PREVIEW_LIMIT).map(chapter => ({
    number: chapter.number,
    title: chapter.title,
    wordCount: chapter.wordCount,
    targetStatus: conflicts.has(chapter.number)
      ? 'conflict' as const
      : duplicates.has(chapter.number)
        ? 'duplicate' as const
        : fresh.has(chapter.number)
          ? 'new' as const
          : 'duplicate' as const,
  }))
  return {
    inspectionId,
    purpose,
    sourceCount: sourceDisplay.length,
    sourceDisplayNames: sourceDisplay.map(source => source.displayName),
    chapterCount: chapters.length,
    totalWords: chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
    totalBytes: chapters.reduce((sum, chapter) => sum + chapter.contentSize, 0),
    preview,
    previewRemaining: Math.max(0, chapters.length - preview.length),
  }
}

export function normalizeDisplay(items: ImportSourceDisplayMetadata[]): ImportSourceDisplayMetadata[] {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_DISPLAY_SOURCES) {
    throw new Error('导入来源展示信息无效')
  }
  return items.map(item => {
    const displayName = item.displayName?.trim()
    const mediaType = item.mediaType?.trim()
    if (!displayName || displayName.length > 255 || displayName.includes('/') || displayName.includes('\\')) {
      throw new Error('导入来源展示名无效')
    }
    if (!mediaType || mediaType.length > 100 || !Number.isSafeInteger(item.size) || item.size < 0) {
      throw new Error('导入来源展示信息无效')
    }
    return { displayName, mediaType, size: item.size }
  })
}

export function normalizeSourceIds(
  items: string[] | undefined,
  sourceDisplay: ImportSourceDisplayMetadata[],
  sourceFingerprint: string,
): string[] {
  if (items === undefined) return [`legacy:${sourceFingerprint}`]
  if (!Array.isArray(items) || items.length !== sourceDisplay.length || items.length === 0) {
    throw new Error('导入来源身份与展示信息不匹配')
  }
  const normalized = items.map(item => item?.trim())
  if (normalized.some(item => !OPAQUE_SOURCE_ID.test(item)) || new Set(normalized).size !== normalized.length) {
    throw new Error('导入来源身份无效或重复')
  }
  return normalized
}

export function normalizeSourceFingerprints(items: string[] | undefined, sourceIds: string[]): string[] {
  if (items === undefined) return []
  if (
    !Array.isArray(items)
    || items.length !== sourceIds.length
    || items.some(item => !SHA256.test(item))
  ) throw new Error('导入来源单文件指纹无效')
  return items
}

export function normalizeChapters(
  items: ImportRunChapterInput[],
  sourceIds: string[],
): NormalizedImportRunChapter[] {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_IMPORT_CHAPTERS) {
    throw new Error('导入章节清单无效')
  }
  const sourceChapters = new Set<string>()
  let aggregateBytes = 0
  const normalized = items.map(item => {
    const sourceIndex = item.sourceIndex ?? 0
    const sourceChapterNumber = item.sourceChapterNumber ?? item.number
    if (
      !Number.isSafeInteger(item.number)
      || item.number < 1
      || !Number.isSafeInteger(sourceIndex)
      || sourceIndex < 0
      || sourceIndex >= sourceIds.length
      || !Number.isSafeInteger(sourceChapterNumber)
      || sourceChapterNumber < 1
    ) throw new Error('导入章节归属无效')
    const sourceId = sourceIds[sourceIndex]
    const affiliation = `${sourceId}:${sourceChapterNumber}`
    if (sourceChapters.has(affiliation)) throw new Error('导入章节来源归属重复')
    sourceChapters.add(affiliation)
    const bytes = Buffer.byteLength(item.content, 'utf8')
    if (
      typeof item.title !== 'string'
      || item.title.length > 500
      || !SHA256.test(item.contentFingerprint)
      || !Number.isSafeInteger(item.contentSize)
      || item.contentSize !== bytes
      || bytes === 0
      || bytes > MAX_CHAPTER_BYTES
    ) throw new Error(`导入章节 ${item.number} 快照无效`)
    aggregateBytes += bytes
    if (aggregateBytes > MAX_IMPORT_TOTAL_BYTES) throw new Error('导入正文总字节数超过安全上限')
    return { ...item, title: item.title.trim(), sourceIndex, sourceId, sourceChapterNumber }
  })
  return normalized
}

export function sourceChapterKey(sourceId: string, sourceChapterNumber: number): string {
  return `${sourceId}:${sourceChapterNumber}`
}

export function completedChapterManifest(
  purpose: ImportPurpose,
  sourceIds: string[],
): Map<string, { number: number; title: string; contentFingerprint: string; contentSize: number }> {
  const placeholders = sourceIds.map(() => '?').join(', ')
  const rows = db().prepare(`
    SELECT source_map.chapter_number, chapters.source_id, chapters.source_chapter_number,
           chapters.title, chapters.content_fingerprint, chapters.content_size
    FROM import_run_chapters AS chapters
    JOIN import_runs AS runs ON runs.id = chapters.run_id
    JOIN import_source_chapter_map AS source_map
      ON source_map.purpose = runs.purpose
      AND source_map.source_id = chapters.source_id
      AND source_map.source_chapter_number = chapters.source_chapter_number
    WHERE runs.purpose = ? AND runs.status = 'completed'
      AND chapters.source_id IN (${placeholders})
    ORDER BY runs.completed_at ASC, runs.rowid ASC, chapters.chapter_number ASC
  `).all(purpose, ...sourceIds) as Array<{
    chapter_number: number
    source_id: string
    source_chapter_number: number
    title: string
    content_fingerprint: string
    content_size: number
  }>
  return new Map(rows.map(row => [sourceChapterKey(row.source_id, row.source_chapter_number), {
    number: row.chapter_number,
    title: row.title,
    contentFingerprint: row.content_fingerprint,
    contentSize: row.content_size,
  }]))
}

export function assignStableChapterNumbers(
  purpose: ImportPurpose,
  chapters: NormalizedImportRunChapter[],
): {
  chapters: NormalizedImportRunChapter[]
  newMappings: Array<{ sourceId: string; sourceChapterNumber: number; chapterNumber: number }>
} {
  const readMapping = db().prepare(`
    SELECT chapter_number FROM import_source_chapter_map
    WHERE purpose = ? AND source_id = ? AND source_chapter_number = ?
  `)
  let nextChapterNumber = (db().prepare(`
    SELECT COALESCE(MAX(chapter_number), 0) AS value
    FROM import_source_chapter_map WHERE purpose = ?
  `).get(purpose) as { value: number }).value
  const newMappings: Array<{ sourceId: string; sourceChapterNumber: number; chapterNumber: number }> = []
  const numbered = chapters.map(chapter => {
    const row = readMapping.get(
      purpose,
      chapter.sourceId,
      chapter.sourceChapterNumber,
    ) as { chapter_number: number } | undefined
    const number = row?.chapter_number ?? ++nextChapterNumber
    if (!row) newMappings.push({
      sourceId: chapter.sourceId,
      sourceChapterNumber: chapter.sourceChapterNumber,
      chapterNumber: number,
    })
    return { ...chapter, number }
  })
  return { chapters: numbered.sort((left, right) => left.number - right.number), newMappings }
}

export function adoptLegacyCompletedRun(
  purpose: ImportPurpose,
  legacyFingerprint: string,
  candidateChapters: NormalizedImportRunChapter[],
): void {
  if (candidateChapters.length === 0) return
  const legacySourceId = `legacy:${legacyFingerprint}`
  const legacyRun = db().prepare(`
    SELECT id FROM import_runs
    WHERE purpose = ? AND source_fingerprint = ? AND status = 'completed'
    ORDER BY completed_at DESC, rowid DESC LIMIT 1
  `).get(purpose, legacyFingerprint) as { id: string } | undefined
  if (!legacyRun) return
  const legacyChapters = db().prepare(`
    SELECT chapter_number, source_chapter_number, title, content_fingerprint, content_size
    FROM import_run_chapters
    WHERE run_id = ? AND source_id = ?
    ORDER BY chapter_number
  `).all(legacyRun.id, legacySourceId) as Array<{
    chapter_number: number
    source_chapter_number: number
    title: string
    content_fingerprint: string
    content_size: number
  }>
  const orderedCandidates = [...candidateChapters].sort((left, right) => (
    left.number - right.number || left.sourceChapterNumber - right.sourceChapterNumber
  ))
  if (
    legacyChapters.length !== orderedCandidates.length
    || legacyChapters.some((chapter, index) => {
      const candidate = orderedCandidates[index]
      return chapter.title !== candidate.title
        || chapter.content_fingerprint !== candidate.contentFingerprint
        || chapter.content_size !== candidate.contentSize
    })
  ) return

  const updateMapping = db().prepare(`
    UPDATE import_source_chapter_map
    SET source_id = ?, source_chapter_number = ?
    WHERE purpose = ? AND source_id = ? AND source_chapter_number = ?
  `)
  const updateChapters = db().prepare(`
    UPDATE import_run_chapters
    SET source_id = ?, source_chapter_number = ?
    WHERE source_id = ? AND source_chapter_number = ?
      AND run_id IN (SELECT id FROM import_runs WHERE purpose = ? AND source_fingerprint = ?)
  `)
  legacyChapters.forEach((chapter, index) => {
    const candidate = orderedCandidates[index]
    updateMapping.run(
      candidate.sourceId,
      candidate.sourceChapterNumber,
      purpose,
      legacySourceId,
      chapter.source_chapter_number,
    )
    updateChapters.run(
      candidate.sourceId,
      candidate.sourceChapterNumber,
      legacySourceId,
      chapter.source_chapter_number,
      purpose,
      legacyFingerprint,
    )
  })
}

export function matchingResumableRun(purpose: ImportPurpose, sourceFingerprint: string, manifestFingerprint: string): ImportRunRow | undefined {
  return db().prepare(`
    SELECT * FROM import_runs
    WHERE purpose = ? AND source_fingerprint = ? AND manifest_fingerprint = ?
      AND stage <> 'parsing' AND resumable = 1
      AND status IN ('ready', 'running', 'failed', 'cancelled')
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(purpose, sourceFingerprint, manifestFingerprint) as ImportRunRow | undefined
}

export function hasCommittedAuthorFinalizationReceipt(run: ImportRunRow): boolean {
  const receipt = db().prepare(`
    SELECT * FROM import_run_receipts
    WHERE run_id = ? AND kind = 'author-finalized-batch' AND state = 'committed'
    ORDER BY updated_at DESC, rowid DESC LIMIT 1
  `).get(run.id) as ImportRunEffectReceiptRow | undefined
  if (!receipt) return false
  rowToEffectReceipt(receipt, run)
  return true
}

export function fenceUncommittedAuthorRun(run: ImportRunRow, now = Date.now()): void {
  if (run.status === 'running' && run.execution_owner && run.lease_expires_at > now) {
    throw new Error(run.locale === 'en-US'
      ? 'The previous author import is still running. Wait for it to stop, then confirm the latest preview again.'
      : '之前的作者原稿导入仍在运行，请等待其停止后重新确认最新预览')
  }
  const guidance = run.locale === 'en-US'
    ? 'Author manuscript authority changed. Confirm the latest preview to create a new import run.'
    : '作者原稿权威状态已变化，请根据最新预览重新确认导入'
  const fenced = db().prepare(`
    UPDATE import_runs
    SET resumable = 0, cancel_requested = 0, last_error = ?,
        execution_owner = '', execution_epoch = execution_epoch + 1, lease_expires_at = 0,
        updated_at = datetime('now')
    WHERE id = ? AND purpose = 'author-manuscript' AND resumable = 1
      AND status IN ('ready', 'running', 'failed', 'cancelled')
      AND (status <> 'running' OR execution_owner = '' OR lease_expires_at <= ?)
      AND NOT EXISTS (
        SELECT 1 FROM import_run_receipts
        WHERE run_id = import_runs.id
          AND kind = 'author-finalized-batch' AND state = 'committed'
      )
  `).run(guidance, run.id, now)
  if (fenced.changes !== 1) {
    throw new Error(run.locale === 'en-US'
      ? 'The author import state changed. Confirm the latest preview again.'
      : '作者原稿导入状态已变化，请重新确认最新预览')
  }
}

export function discardProvisionalParsingRun(runId: string): void {
  const result = db().prepare(`
    DELETE FROM import_runs
    WHERE id = ? AND stage = 'parsing' AND status IN ('ready', 'failed')
  `).run(runId)
  if (result.changes !== 1) throw new Error('导入解析临时运行无法安全终止')
}

export function latestCompletedRun(purpose: ImportPurpose, sourceFingerprint: string): ImportRunRow | undefined {
  return db().prepare(`
    SELECT * FROM import_runs
    WHERE purpose = ? AND source_fingerprint = ? AND status = 'completed'
    ORDER BY completed_at DESC, rowid DESC LIMIT 1
  `).get(purpose, sourceFingerprint) as ImportRunRow | undefined
}

export function overlappingResumableSourceRun(runId: string, purpose: ImportPurpose): ImportRunRow | undefined {
  return db().prepare(`
    SELECT DISTINCT other_runs.*
    FROM import_runs AS other_runs
    JOIN import_run_sources AS other_sources ON other_sources.run_id = other_runs.id
    JOIN import_run_sources AS current_sources
      ON current_sources.run_id = ?
      AND current_sources.source_fingerprint = other_sources.source_fingerprint
    WHERE other_runs.id <> ?
      AND other_runs.purpose = ?
      AND other_runs.stage <> 'parsing'
      AND other_runs.resumable = 1
      AND other_runs.status IN ('ready', 'running', 'failed', 'cancelled')
    ORDER BY other_runs.updated_at DESC, other_runs.rowid DESC
    LIMIT 1
  `).get(runId, runId, purpose) as ImportRunRow | undefined
}

export function parsedSourceStatus(runId: string, sourceId: string): 'pending' | 'completed' | 'failed' | undefined {
    const row = db().prepare(`
      SELECT status FROM import_run_sources WHERE run_id = ? AND source_id = ?
    `).get(runId, sourceId) as { status: 'pending' | 'completed' | 'failed' } | undefined
    return row?.status
  }

export function beginParsing(candidate: ImportRunBeginParsingRequest): ImportRunSnapshot {
    const runId = candidate.runId?.trim()
    if (!runId || runId.length > 160 || !SHA256.test(candidate.sourceFingerprint)) {
      throw new Error('导入运行身份无效')
    }
    if (candidate.purpose !== 'reference') throw new Error('当前版本不支持作者手稿导入')
    if (candidate.locale !== 'zh-CN' && candidate.locale !== 'en-US') throw new Error('导入运行语言无效')
    const sourceDisplay = normalizeDisplay(candidate.sourceDisplay)
    const sourceIds = normalizeSourceIds(candidate.sourceIds, sourceDisplay, candidate.sourceFingerprint)
    const sourceFingerprints = normalizeSourceFingerprints(candidate.sourceFingerprints, sourceIds)
    if (sourceFingerprints.length !== sourceIds.length) throw new Error('导入来源单文件指纹无效')
    const legacySourceFingerprints = candidate.legacySourceFingerprints ?? sourceIds.map(() => '')
    if (legacySourceFingerprints.length !== sourceIds.length || legacySourceFingerprints.some(value => value !== '' && !SHA256.test(value))) {
      throw new Error('旧导入来源单文件指纹无效')
    }
    if (candidate.legacyCollectionFingerprint && !SHA256.test(candidate.legacyCollectionFingerprint)) {
      throw new Error('旧导入来源集合指纹无效')
    }

    return db().transaction(() => {
      const explicitRun = readRunRow(runId)
      if (explicitRun) {
        const persistedSources = db().prepare(`
          SELECT source_index, source_id, source_fingerprint, legacy_source_fingerprint,
                 display_json, status
          FROM import_run_sources WHERE run_id = ? ORDER BY source_index
        `).all(explicitRun.id) as Array<{
          source_index: number
          source_id: string
          source_fingerprint: string
          legacy_source_fingerprint: string
          display_json: string
          status: 'pending' | 'completed' | 'failed'
        }>
        if (
          explicitRun.purpose !== candidate.purpose
          || explicitRun.stage !== 'parsing'
          || explicitRun.resumable !== 1
          || explicitRun.locale !== candidate.locale
        ) throw new Error('指定的导入运行当前不可重新授权未完成来源')

        const persistedById = new Map(persistedSources.map(source => [source.source_id, source]))
        if (sourceIds.some((sourceId, index) => {
          const persisted = persistedById.get(sourceId)
          return !persisted
            || persisted.status === 'completed'
            || persisted.source_fingerprint !== sourceFingerprints[index]
        })) throw new Error('未完成导入的来源清单与本次重新授权不一致')

        const updateSource = db().prepare(`
          UPDATE import_run_sources
          SET legacy_source_fingerprint = ?, display_json = ?, updated_at = datetime('now')
          WHERE run_id = ? AND source_id = ? AND source_fingerprint = ? AND status <> 'completed'
        `)
        sourceIds.forEach((sourceId, index) => {
          const changed = updateSource.run(
            legacySourceFingerprints[index],
            JSON.stringify(sourceDisplay[index]),
            explicitRun.id,
            sourceId,
            sourceFingerprints[index],
          )
          if (changed.changes !== 1) throw new Error('未完成导入的来源清单与本次重新授权不一致')
          const persisted = persistedById.get(sourceId)!
          persisted.legacy_source_fingerprint = legacySourceFingerprints[index]
          persisted.display_json = JSON.stringify(sourceDisplay[index])
        })
        const fullDisplay = persistedSources.map(source => parseJson<ImportSourceDisplayMetadata>(
          source.display_json,
          { displayName: '', mediaType: '', size: 0 },
        ))
        db().prepare(`
          UPDATE import_runs SET source_display_json = ?, updated_at = datetime('now') WHERE id = ?
        `).run(JSON.stringify(fullDisplay), explicitRun.id)
        return getRun(explicitRun.id)!
      }

      const existing = db().prepare(`
        SELECT * FROM import_runs
        WHERE purpose = ? AND source_fingerprint = ? AND stage = 'parsing' AND resumable = 1
        ORDER BY updated_at DESC, rowid DESC LIMIT 1
      `).get(candidate.purpose, candidate.sourceFingerprint) as ImportRunRow | undefined
      if (existing) {
        const sources = db().prepare(`
          SELECT source_id, source_fingerprint, legacy_source_fingerprint, display_json
          FROM import_run_sources WHERE run_id = ? ORDER BY source_index
        `).all(existing.id) as Array<{ source_id: string; source_fingerprint: string; legacy_source_fingerprint: string; display_json: string }>
        const sourcesById = new Map(sources.map(source => [source.source_id, source]))
        if (
          sources.length !== sourceIds.length
          || sourceIds.some((sourceId, index) => (
            sourcesById.get(sourceId)?.source_fingerprint !== sourceFingerprints[index]
          ))
        ) throw new Error('未完成导入的来源清单与本次重新授权不一致')
        db().prepare(`
          UPDATE import_run_sources
          SET source_index = source_index + ?
          WHERE run_id = ?
        `).run(MAX_IMPORT_SOURCE_FILES, existing.id)
        const updateSource = db().prepare(`
          UPDATE import_run_sources
          SET source_index = ?, legacy_source_fingerprint = ?, display_json = ?, updated_at = datetime('now')
          WHERE run_id = ? AND source_id = ? AND source_fingerprint = ?
        `)
        sourceIds.forEach((sourceId, index) => {
          const changed = updateSource.run(
            index,
            legacySourceFingerprints[index],
            JSON.stringify(sourceDisplay[index]),
            existing.id,
            sourceId,
            sourceFingerprints[index],
          )
          if (changed.changes !== 1) throw new Error('未完成导入的来源清单与本次重新授权不一致')
        })
        db().prepare(`
          UPDATE import_runs SET source_display_json = ?, updated_at = datetime('now') WHERE id = ?
        `).run(JSON.stringify(sourceDisplay), existing.id)
        return getRun(existing.id)!
      }
      if (readRunRow(runId)) throw new Error('导入运行 ID 已存在')
      db().prepare(`
        INSERT INTO import_runs (
          id, purpose, root_run_id, effect_namespace, source_fingerprint, manifest_fingerprint, legacy_source_fingerprint,
          source_display_json, locale, stage, status, total_chapters, total_content_size,
          manifest_chapter_count, manifest_content_size, manifest_word_count, completed_chapters
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'parsing', 'ready', 0, 0, 0, 0, 0, 0)
      `).run(
        runId,
        candidate.purpose,
        runId,
        `import:${candidate.purpose}:${runId}`,
        candidate.sourceFingerprint,
        '0'.repeat(64),
        candidate.legacyCollectionFingerprint ?? '',
        JSON.stringify(sourceDisplay),
        candidate.locale,
      )
      const insertSource = db().prepare(`
        INSERT INTO import_run_sources (
          run_id, source_index, source_id, source_fingerprint, legacy_source_fingerprint, display_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      sourceIds.forEach((sourceId, index) => insertSource.run(
        runId,
        index,
        sourceId,
        sourceFingerprints[index],
        legacySourceFingerprints[index],
        JSON.stringify(sourceDisplay[index]),
      ))
      return getRun(runId)!
    })()
  }

export function commitParsedSource(
    runId: string,
    sourceId: string,
    chapters: ImportRunChapterInput[],
  ): ImportRunSnapshot {
    if (!OPAQUE_SOURCE_ID.test(sourceId)) throw new Error('导入解析来源身份无效')
    if (!Array.isArray(chapters) || chapters.length === 0) throw new Error('导入解析来源没有可导入的正文')
    if (chapters.some(chapter => (
      createHash('sha256').update(chapter.content, 'utf8').digest('hex') !== chapter.contentFingerprint
    ))) throw new Error('导入解析来源内容指纹与冻结快照不一致')
    const normalized = normalizeChapters(chapters, [sourceId])
    const manifestFingerprint = hashManifest('reference', normalized.map((chapter, index) => ({
      ...chapter,
      number: index + 1,
    })))
    return db().transaction(() => {
      const run = readRunRow(runId)
      if (!run || run.purpose !== 'reference' || run.stage !== 'parsing' || !['ready', 'failed'].includes(run.status)) {
        throw new Error('导入解析运行当前不可写入来源')
      }
      const source = db().prepare(`
        SELECT * FROM import_run_sources WHERE run_id = ? AND source_id = ?
      `).get(runId, sourceId) as ImportRunSourceRow | undefined
      if (!source) throw new Error('导入解析来源不存在')
      if (source.status === 'completed') {
        if (source.manifest_fingerprint !== manifestFingerprint) throw new Error('已完成来源与本次重新授权内容不一致')
        return getRun(runId)!
      }
      db().prepare('DELETE FROM import_run_source_chapters WHERE run_id = ? AND source_id = ?')
        .run(runId, sourceId)
      const insert = db().prepare(`
        INSERT INTO import_run_source_chapters (
          run_id, source_id, source_chapter_number, title, content_fingerprint,
          content_size, word_count, content_snapshot
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const chapter of normalized) {
        insert.run(
          runId,
          sourceId,
          chapter.sourceChapterNumber,
          chapter.title,
          chapter.contentFingerprint,
          chapter.contentSize,
          countDraftUnits(chapter.content),
          chapter.content,
        )
      }
      db().prepare(`
        UPDATE import_run_sources
        SET status = 'completed', manifest_fingerprint = ?, chapter_count = ?,
            content_size = ?, word_count = ?, last_error = '', updated_at = datetime('now')
        WHERE run_id = ? AND source_id = ?
      `).run(
        manifestFingerprint,
        normalized.length,
        normalized.reduce((sum, chapter) => sum + chapter.contentSize, 0),
        normalized.reduce((sum, chapter) => sum + countDraftUnits(chapter.content), 0),
        runId,
        sourceId,
      )
      db().prepare(`
        UPDATE import_runs
        SET status = 'ready', last_error = '',
            total_chapters = (SELECT COALESCE(SUM(chapter_count), 0) FROM import_run_sources WHERE run_id = ? AND status = 'completed'),
            total_content_size = (SELECT COALESCE(SUM(content_size), 0) FROM import_run_sources WHERE run_id = ? AND status = 'completed'),
            updated_at = datetime('now')
        WHERE id = ?
      `).run(runId, runId, runId)
      return getRun(runId)!
    })()
  }

export function failParsedSource(runId: string, sourceId: string, error: string): ImportRunSnapshot {
    if (typeof error !== 'string' || !error.trim()) throw new Error('导入解析失败原因无效')
    return db().transaction(() => {
      const run = readRunRow(runId)
      if (!run || run.stage !== 'parsing' || !['ready', 'failed'].includes(run.status)) {
        throw new Error('导入解析运行当前不可标记失败')
      }
      const changed = db().prepare(`
        UPDATE import_run_sources
        SET status = 'failed', last_error = ?, updated_at = datetime('now')
        WHERE run_id = ? AND source_id = ? AND status <> 'completed'
      `).run(error.slice(0, 2_000), runId, sourceId)
      if (changed.changes !== 1) throw new Error('导入解析来源当前不可标记失败')
      db().prepare(`
        UPDATE import_runs SET status = 'failed', last_error = ?, resumable = 1,
          updated_at = datetime('now') WHERE id = ?
      `).run(error.slice(0, 2_000), runId)
      return getRun(runId)!
    })()
  }

export function finalizeParsing(runId: string): ImportRunPreparationResult {
    return db().transaction(() => {
      const run = readRunRow(runId)
      if (!run || run.stage !== 'parsing' || !['ready', 'failed'].includes(run.status)) {
        throw new Error('导入解析运行当前不可完成')
      }
      const sources = db().prepare(`
        SELECT * FROM import_run_sources WHERE run_id = ? ORDER BY source_index
      `).all(runId) as ImportRunSourceRow[]
      if (sources.length === 0 || sources.some(source => source.status !== 'completed')) {
        throw new Error('导入来源解析尚未完成，请重新授权未完成来源')
      }
      const metadata = db().prepare(`
        SELECT sources.source_index, chapters.source_id, chapters.source_chapter_number,
               chapters.title, chapters.content_fingerprint, chapters.content_size, chapters.word_count
        FROM import_run_source_chapters AS chapters
        JOIN import_run_sources AS sources
          ON sources.run_id = chapters.run_id AND sources.source_id = chapters.source_id
        WHERE chapters.run_id = ?
        ORDER BY sources.source_index, chapters.source_chapter_number
      `).all(runId) as Array<{
        source_index: number
        source_id: string
        source_chapter_number: number
        title: string
        content_fingerprint: string
        content_size: number
        word_count: number
      }>
      if (
        metadata.length === 0
        || metadata.length > MAX_IMPORT_CHAPTERS
        || metadata.length !== sources.reduce((sum, source) => sum + source.chapter_count, 0)
        || sources.reduce((sum, source) => sum + source.content_size, 0) > MAX_IMPORT_TOTAL_BYTES
      ) throw new Error('导入解析 manifest 无效')
      const normalized = metadata.map((chapter, index): NormalizedImportRunChapter => ({
        number: index + 1,
        sourceIndex: chapter.source_index,
        sourceId: chapter.source_id,
        sourceChapterNumber: chapter.source_chapter_number,
        title: chapter.title,
        contentFingerprint: chapter.content_fingerprint,
        contentSize: chapter.content_size,
        content: '',
      }))
      sources.forEach((source, sourceIndex) => {
        if (source.legacy_source_fingerprint) {
          adoptLegacyCompletedRun(
            run.purpose,
            source.legacy_source_fingerprint,
            normalized.filter(chapter => chapter.sourceIndex === sourceIndex),
          )
        }
      })
      if (run.legacy_source_fingerprint) {
        adoptLegacyCompletedRun(run.purpose, run.legacy_source_fingerprint, normalized)
      }
      const assignment = assignStableChapterNumbers(run.purpose, normalized)
      const chapters = assignment.chapters
      const sourceDisplay = sources.map(source => parseJson<ImportSourceDisplayMetadata>(
        source.display_json,
        { displayName: '', mediaType: '', size: 0 },
      ))
      const wordCounts = new Map(metadata.map(chapter => [
        sourceChapterKey(chapter.source_id, chapter.source_chapter_number),
        chapter.word_count,
      ]))
      const previewChapters = chapters.map(chapter => ({
        number: chapter.number,
        title: chapter.title,
        wordCount: wordCounts.get(sourceChapterKey(chapter.sourceId, chapter.sourceChapterNumber)) ?? 0,
        contentSize: chapter.contentSize,
      }))
      const inspectionFor = (
        newChapterNumbers: number[],
        conflictChapterNumbers: number[],
        duplicateChapterNumbers: number[],
      ) => createPreparationInspection(runId, run.purpose, sourceDisplay, previewChapters, {
        newChapterNumbers, conflictChapterNumbers, duplicateChapterNumbers,
      })
      const manifestFingerprint = hashManifest(run.purpose, chapters)
      const resumable = matchingResumableRun(run.purpose, run.source_fingerprint, manifestFingerprint)
      if (resumable && resumable.id !== runId) {
        const duplicateChapterNumbers = chapters.map(chapter => chapter.number)
        discardProvisionalParsingRun(runId)
        return {
          classification: 'resumable' as const,
          run: rowToSnapshot(resumable),
          newChapterNumbers: [],
          conflictChapterNumbers: [],
          duplicateChapterNumbers,
          inspection: inspectionFor([], [], duplicateChapterNumbers),
        }
      }
      if (overlappingResumableSourceRun(runId, run.purpose)) {
        throw new Error(run.locale === 'en-US'
          ? 'Another resumable import already contains the same source. Complete or cancel that import, then try again.'
          : '另一个可恢复导入已包含相同来源，请先完成或取消该导入后重试')
      }
      const sourceIds = sources.map(source => source.source_id)
      const completed = latestCompletedRun(run.purpose, run.source_fingerprint)
      const completedManifest = completedChapterManifest(run.purpose, sourceIds)
      const conflictChapterNumbers = chapters.filter(chapter => {
        const previous = completedManifest.get(sourceChapterKey(chapter.sourceId, chapter.sourceChapterNumber))
        return previous !== undefined && (
          previous.title !== chapter.title
          || previous.contentFingerprint !== chapter.contentFingerprint
          || previous.contentSize !== chapter.contentSize
        )
      }).map(chapter => chapter.number)
      const duplicateChapterNumbers = chapters.filter(chapter => {
        const previous = completedManifest.get(sourceChapterKey(chapter.sourceId, chapter.sourceChapterNumber))
        return previous !== undefined
          && previous.title === chapter.title
          && previous.contentFingerprint === chapter.contentFingerprint
          && previous.contentSize === chapter.contentSize
      }).map(chapter => chapter.number)
      const newChapters = chapters.filter(chapter => (
        !completedManifest.has(sourceChapterKey(chapter.sourceId, chapter.sourceChapterNumber))
      ))
      if (conflictChapterNumbers.length > 0) {
        discardProvisionalParsingRun(runId)
        return {
          classification: 'conflict' as const, run: undefined,
          newChapterNumbers: newChapters.map(chapter => chapter.number),
          conflictChapterNumbers, duplicateChapterNumbers,
          inspection: inspectionFor(
            newChapters.map(chapter => chapter.number), conflictChapterNumbers, duplicateChapterNumbers,
          ),
        }
      }
      if (newChapters.length === 0) {
        db().prepare('DELETE FROM import_runs WHERE id = ?').run(runId)
        return {
          classification: 'exact-duplicate' as const, run: undefined,
          newChapterNumbers: [], conflictChapterNumbers: [], duplicateChapterNumbers,
          inspection: inspectionFor([], [], duplicateChapterNumbers),
        }
      }
      const insertMapping = db().prepare(`
        INSERT INTO import_source_chapter_map (purpose, source_id, source_chapter_number, chapter_number)
        VALUES (?, ?, ?, ?)
      `)
      assignment.newMappings.forEach(mapping => insertMapping.run(
        run.purpose, mapping.sourceId, mapping.sourceChapterNumber, mapping.chapterNumber,
      ))
      const insertChapter = db().prepare(`
        INSERT INTO import_run_chapters (
          run_id, chapter_number, source_id, source_chapter_number,
          title, content_fingerprint, content_size, content_snapshot
        )
        SELECT ?, ?, source_id, source_chapter_number, title, content_fingerprint, content_size, content_snapshot
        FROM import_run_source_chapters
        WHERE run_id = ? AND source_id = ? AND source_chapter_number = ?
      `)
      for (const chapter of newChapters) {
        insertChapter.run(runId, chapter.number, runId, chapter.sourceId, chapter.sourceChapterNumber)
      }
      db().prepare(`
        UPDATE import_runs
        SET stage = 'prepared', status = 'ready', manifest_fingerprint = ?,
            total_chapters = ?, total_content_size = ?, manifest_chapter_count = ?,
            manifest_content_size = ?, manifest_word_count = ?, completed_chapters = 0,
            base_run_id = ?, last_error = '', updated_at = datetime('now')
        WHERE id = ? AND stage = 'parsing'
      `).run(
        manifestFingerprint,
        newChapters.length,
        newChapters.reduce((sum, chapter) => sum + chapter.contentSize, 0),
        chapters.length,
        sources.reduce((sum, source) => sum + source.content_size, 0),
        sources.reduce((sum, source) => sum + source.word_count, 0),
        completed?.id ?? null,
        runId,
      )
      return {
        classification: 'new' as const, run: getRun(runId)!,
        newChapterNumbers: newChapters.map(chapter => chapter.number),
        conflictChapterNumbers: [], duplicateChapterNumbers,
        inspection: inspectionFor(
          newChapters.map(chapter => chapter.number), [], duplicateChapterNumbers,
        ),
      }
    })()
  }

export function prepare(candidate: ImportRunPrepareRequest): ImportRunPreparationResult {
    const runId = candidate.runId?.trim()
    if (!runId || runId.length > 160 || !SHA256.test(candidate.sourceFingerprint)) {
      throw new Error('导入运行身份无效')
    }
    if (candidate.purpose !== 'reference' && candidate.purpose !== 'author-manuscript') {
      throw new Error('导入用途无效')
    }
    if (candidate.locale !== 'zh-CN' && candidate.locale !== 'en-US') throw new Error('导入运行语言无效')
    const sourceDisplay = normalizeDisplay(candidate.sourceDisplay)
    const sourceIds = normalizeSourceIds(candidate.sourceIds, sourceDisplay, candidate.sourceFingerprint)
    const sourceFingerprints = normalizeSourceFingerprints(candidate.sourceFingerprints, sourceIds)
    const normalizedChapters = normalizeChapters(candidate.chapters, sourceIds)

    return db().transaction(() => {
      if (candidate.purpose === 'author-manuscript') {
        if (
          !candidate.authorityFingerprint
          || !SHA256.test(candidate.authorityFingerprint)
          || !candidate.expectedManifestFingerprint
          || !SHA256.test(candidate.expectedManifestFingerprint)
        ) throw new Error('作者原稿缺少已确认的权威预览')
        const authorChapters = normalizedChapters
          .map(chapter => ({
            chapterNumber: chapter.number,
            title: chapter.title,
            content: chapter.content,
            wordCount: countDraftUnits(chapter.content),
          }))
          .sort((left, right) => left.chapterNumber - right.chapterNumber)
        const preview = FinalizedDraftImportRepository.preview(authorChapters)
        if (preview.manifestFingerprint !== candidate.expectedManifestFingerprint) {
          throw new Error('作者原稿清单与已确认预览不一致')
        }
        const resumable = matchingResumableRun(
          candidate.purpose,
          candidate.sourceFingerprint,
          preview.manifestFingerprint,
        )
        if (preview.authorityFingerprint !== candidate.authorityFingerprint) {
          throw new AuthorImportPreviewStaleError('项目权威章节已变化，作者原稿预览已过期')
        }
        if (resumable) {
          if (
            hasCommittedAuthorFinalizationReceipt(resumable)
            || resumable.authority_fingerprint === preview.authorityFingerprint
          ) {
            return {
              classification: 'resumable' as const,
              run: rowToSnapshot(resumable),
              newChapterNumbers: [],
              conflictChapterNumbers: [],
              duplicateChapterNumbers: authorChapters.map(chapter => chapter.chapterNumber),
            }
          }
          fenceUncommittedAuthorRun(resumable)
        }
        if (preview.classification === 'conflict') {
          if (preview.authorityInvalid) {
            throw new Error(
              `现有权威正文章节不连续；请先修复第 ${preview.firstGapChapterNumber ?? '?'} 章附近的数据`,
            )
          }
          if (preview.conflictChapterNumbers.length > 0) {
            throw new Error(
              `作者原稿与现有正文冲突：第 ${preview.conflictChapterNumbers.join('、')} 章`,
            )
          }
          throw new Error(
            `作者原稿存在缺章；请从第 ${preview.firstGapChapterNumber ?? '?'} 章连续导入`,
          )
        }
        if (preview.classification === 'exact-duplicate') {
          return {
            classification: 'exact-duplicate' as const,
            run: undefined,
            newChapterNumbers: [],
            conflictChapterNumbers: [],
            duplicateChapterNumbers: preview.duplicateChapterNumbers,
          }
        }
        if (readRunRow(runId)) throw new Error('导入运行 ID 已存在')
        const newChapterSet = new Set(preview.newChapterNumbers)
        const chaptersToPersist = normalizedChapters
          .filter(chapter => newChapterSet.has(chapter.number))
          .sort((left, right) => left.number - right.number)
        const manifestContentSize = normalizedChapters.reduce((sum, chapter) => sum + chapter.contentSize, 0)
        const manifestWordCount = normalizedChapters.reduce((sum, chapter) => sum + countDraftUnits(chapter.content), 0)
        db().prepare(`
          INSERT INTO import_runs (
            id, purpose, root_run_id, effect_namespace, source_fingerprint, manifest_fingerprint,
            authority_fingerprint, source_display_json, locale, stage, status,
            total_chapters, total_content_size, completed_chapters, base_run_id,
            manifest_chapter_count, manifest_content_size, manifest_word_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'author-commit', 'ready', ?, ?, 0, NULL, ?, ?, ?)
        `).run(
          runId,
          candidate.purpose,
          runId,
          `import:${candidate.purpose}:${runId}`,
          candidate.sourceFingerprint,
          preview.manifestFingerprint,
          candidate.authorityFingerprint,
          JSON.stringify(sourceDisplay),
          candidate.locale,
          chaptersToPersist.length,
          chaptersToPersist.reduce((sum, chapter) => sum + chapter.contentSize, 0),
          normalizedChapters.length,
          manifestContentSize,
          manifestWordCount,
        )
        const insertChapter = db().prepare(`
          INSERT INTO import_run_chapters (
            run_id, chapter_number, source_id, source_chapter_number,
            title, content_fingerprint, content_size, content_snapshot
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        for (const chapter of chaptersToPersist) {
          insertChapter.run(
            runId,
            chapter.number,
            chapter.sourceId,
            chapter.sourceChapterNumber,
            chapter.title,
            chapter.contentFingerprint,
            chapter.contentSize,
            chapter.content,
          )
        }
        const created = readRunRow(runId)
        if (!created) throw new Error('作者原稿导入运行创建失败')
        return {
          classification: 'new' as const,
          run: rowToSnapshot(created),
          newChapterNumbers: preview.newChapterNumbers,
          conflictChapterNumbers: [],
          duplicateChapterNumbers: preview.duplicateChapterNumbers,
        }
      }

      sourceFingerprints.forEach((fingerprint, sourceIndex) => {
        adoptLegacyCompletedRun(
          candidate.purpose,
          fingerprint,
          normalizedChapters.filter(chapter => chapter.sourceIndex === sourceIndex),
        )
      })
      adoptLegacyCompletedRun(candidate.purpose, candidate.sourceFingerprint, normalizedChapters)
      const assignment = assignStableChapterNumbers(candidate.purpose, normalizedChapters)
      const chapters = assignment.chapters
      const manifestFingerprint = hashManifest(candidate.purpose, chapters)
      const manifestContentSize = chapters.reduce((sum, chapter) => sum + chapter.contentSize, 0)
      const manifestWordCount = chapters.reduce((sum, chapter) => sum + countDraftUnits(chapter.content), 0)
      const previewChapters = chapters.map(chapter => ({
        number: chapter.number,
        title: chapter.title,
        wordCount: countDraftUnits(chapter.content),
        contentSize: chapter.contentSize,
      }))
      const inspectionFor = (
        newChapterNumbers: number[],
        conflictChapterNumbers: number[],
        duplicateChapterNumbers: number[],
      ) => createPreparationInspection(candidate.runId, candidate.purpose, sourceDisplay, previewChapters, {
        newChapterNumbers, conflictChapterNumbers, duplicateChapterNumbers,
      })
      const resumable = matchingResumableRun(candidate.purpose, candidate.sourceFingerprint, manifestFingerprint)
      if (resumable) {
        const duplicateChapterNumbers = chapters.map(chapter => chapter.number)
        return {
          classification: 'resumable' as const,
          run: rowToSnapshot(resumable),
          newChapterNumbers: [],
          conflictChapterNumbers: [],
          duplicateChapterNumbers,
          inspection: inspectionFor([], [], duplicateChapterNumbers),
        }
      }

      const completed = latestCompletedRun(candidate.purpose, candidate.sourceFingerprint)
      const completedManifest = completedChapterManifest(candidate.purpose, sourceIds)
      const conflictChapterNumbers = chapters
        .filter(chapter => {
          const previous = completedManifest.get(sourceChapterKey(chapter.sourceId, chapter.sourceChapterNumber))
          return previous !== undefined && (
            previous.title !== chapter.title
            || previous.contentFingerprint !== chapter.contentFingerprint
            || previous.contentSize !== chapter.contentSize
          )
        })
        .map(chapter => chapter.number)
      const duplicateChapterNumbers = chapters
        .filter(chapter => {
          const previous = completedManifest.get(sourceChapterKey(chapter.sourceId, chapter.sourceChapterNumber))
          return previous !== undefined
            && previous.title === chapter.title
            && previous.contentFingerprint === chapter.contentFingerprint
            && previous.contentSize === chapter.contentSize
        })
        .map(chapter => chapter.number)
      const newChapters = chapters.filter(chapter => (
        !completedManifest.has(sourceChapterKey(chapter.sourceId, chapter.sourceChapterNumber))
      ))

      if (conflictChapterNumbers.length > 0) {
        return {
          classification: 'conflict' as const,
          run: undefined,
          newChapterNumbers: newChapters.map(chapter => chapter.number),
          conflictChapterNumbers,
          duplicateChapterNumbers,
          inspection: inspectionFor(
            newChapters.map(chapter => chapter.number), conflictChapterNumbers, duplicateChapterNumbers,
          ),
        }
      }
      const chaptersToPersist = newChapters
      if (chaptersToPersist.length === 0) {
        return {
          classification: 'exact-duplicate' as const,
          run: undefined,
          newChapterNumbers: [],
          conflictChapterNumbers: [],
          duplicateChapterNumbers,
          inspection: inspectionFor([], [], duplicateChapterNumbers),
        }
      }
      if (readRunRow(runId)) throw new Error('导入运行 ID 已存在')

      const insertMapping = db().prepare(`
        INSERT INTO import_source_chapter_map (
          purpose, source_id, source_chapter_number, chapter_number
        ) VALUES (?, ?, ?, ?)
      `)
      for (const mapping of assignment.newMappings) {
        insertMapping.run(
          candidate.purpose,
          mapping.sourceId,
          mapping.sourceChapterNumber,
          mapping.chapterNumber,
        )
      }

      db().prepare(`
        INSERT INTO import_runs (
          id, purpose, root_run_id, effect_namespace, source_fingerprint, manifest_fingerprint, source_display_json,
          locale, stage, status, total_chapters, total_content_size, completed_chapters, base_run_id
          , manifest_chapter_count, manifest_content_size, manifest_word_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'knowledge', 'ready', ?, ?, 0, ?, ?, ?, ?)
      `).run(
        runId,
        candidate.purpose,
        runId,
        `import:${candidate.purpose}:${runId}`,
        candidate.sourceFingerprint,
        manifestFingerprint,
        JSON.stringify(sourceDisplay),
        candidate.locale,
        chaptersToPersist.length,
        chaptersToPersist.reduce((sum, chapter) => sum + chapter.contentSize, 0),
        completed?.id ?? null,
        chapters.length,
        manifestContentSize,
        manifestWordCount,
      )
      const insertChapter = db().prepare(`
        INSERT INTO import_run_chapters (
          run_id, chapter_number, source_id, source_chapter_number,
          title, content_fingerprint, content_size, content_snapshot
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (let offset = 0; offset < chaptersToPersist.length; offset += INSERT_BATCH_SIZE) {
        for (const chapter of chaptersToPersist.slice(offset, offset + INSERT_BATCH_SIZE)) {
          insertChapter.run(
            runId,
            chapter.number,
            chapter.sourceId,
            chapter.sourceChapterNumber,
            chapter.title,
            chapter.contentFingerprint,
            chapter.contentSize,
            chapter.content,
          )
        }
      }
      const created = readRunRow(runId)
      if (!created) throw new Error('导入运行创建失败')
      return {
        classification: 'new' as const,
        run: rowToSnapshot(created),
        newChapterNumbers: chaptersToPersist.map(chapter => chapter.number),
        conflictChapterNumbers: [],
        duplicateChapterNumbers,
        inspection: inspectionFor(
          chaptersToPersist.map(chapter => chapter.number), [], duplicateChapterNumbers,
        ),
      }
    })()
  }
