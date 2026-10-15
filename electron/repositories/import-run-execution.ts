import type {
  ImportRunExecutionLease,
  ImportRunSnapshot,
  ImportRunStage,
  ImportRunStartResult,
} from '../../src/shared/import-run'
import {
  db,
  getRun,
  readRunRow,
  assertExecution,
  assertStageCheckpointComplete,
  applyBatchCheckpoint,
  type ImportRunRow,
} from './import-run-store'

export const DEFAULT_EXECUTION_LEASE_MS = 15 * 60_000

export const REFERENCE_NEXT_STAGE: Readonly<Partial<Record<ImportRunStage, ImportRunStage>>> = {
  prepared: 'knowledge',
  knowledge: 'global',
  global: 'style',
  style: 'blueprints',
  blueprints: 'refresh',
}
export const AUTHOR_NEXT_STAGE: Readonly<Partial<Record<ImportRunStage, ImportRunStage>>> = {
  'author-commit': 'author-publish',
  'author-publish': 'author-postprocess',
  'author-postprocess': 'refresh',
}

export function nextStageForRun(row: ImportRunRow, stage: ImportRunStage): ImportRunStage | undefined {
  if (row.purpose === 'author-manuscript') return AUTHOR_NEXT_STAGE[stage]
  return REFERENCE_NEXT_STAGE[stage]
}

export function startOrResume(
    runId: string,
    owner: string,
    now = Date.now(),
    leaseMs = DEFAULT_EXECUTION_LEASE_MS,
  ): ImportRunStartResult {
    const normalizedOwner = owner.trim()
    if (!normalizedOwner || normalizedOwner.length > 160 || leaseMs < 1) throw new Error('导入执行器身份无效')
    return db().transaction(() => {
      const row = readRunRow(runId)
      if (!row || row.resumable !== 1 || !['ready', 'running', 'failed', 'cancelled'].includes(row.status)) {
        throw new Error(row?.resumable === 0 && row.last_error
          ? row.last_error
          : '导入运行当前不可启动')
      }
      if (row.stage === 'parsing') {
        throw new Error('导入解析尚未完成，请重新选择并授权未完成来源')
      }
      const activeProjectRun = db().prepare(`
        SELECT id FROM import_runs
        WHERE id <> ? AND status = 'running' AND execution_owner <> '' AND lease_expires_at > ?
        LIMIT 1
      `).get(runId, now) as { id: string } | undefined
      if (activeProjectRun) throw new Error('项目中另一导入运行正在执行')
      if (row.execution_owner && row.execution_owner !== normalizedOwner && row.lease_expires_at > now) {
        throw new Error('导入运行正在由另一执行器运行')
      }
      const sameActiveOwner = row.execution_owner === normalizedOwner && row.lease_expires_at > now
      const epoch = sameActiveOwner ? row.execution_epoch : row.execution_epoch + 1
      const expiresAt = now + leaseMs
      db().prepare(`
        UPDATE import_runs
        SET stage = CASE WHEN stage = 'prepared' THEN 'knowledge' ELSE stage END,
            status = 'running', resumable = 1, cancel_requested = 0,
            last_error = '', execution_owner = ?, execution_epoch = ?, lease_expires_at = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(normalizedOwner, epoch, expiresAt, runId)
      return {
        run: getRun(runId)!,
        execution: { owner: normalizedOwner, epoch, expiresAt },
      }
    })()
  }

export function renewExecution(runId: string, execution: ImportRunExecutionLease, now = Date.now(), leaseMs = DEFAULT_EXECUTION_LEASE_MS): ImportRunExecutionLease {
    assertExecution(runId, execution, now)
    const expiresAt = now + leaseMs
    db().prepare(`UPDATE import_runs SET lease_expires_at = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(expiresAt, runId)
    return { ...execution, expiresAt }
  }

export function restart(runId: string, nextRunId: string, now = Date.now()): ImportRunSnapshot {
    const normalizedNextId = nextRunId.trim()
    if (!normalizedNextId || normalizedNextId.length > 160) throw new Error('新导入运行 ID 无效')
    return db().transaction(() => {
      const source = readRunRow(runId)
      const restartable = source?.status === 'failed'
        || source?.status === 'cancelled'
        || (source?.status === 'running' && source.lease_expires_at <= now)
      if (!source || !restartable || source.resumable !== 1) {
        throw new Error('导入运行当前不可重新开始')
      }
      if (source.purpose === 'author-manuscript') {
        throw new Error('作者原稿导入不能重新开始；请继续原运行以完成发布和后处理')
      }
      if (readRunRow(normalizedNextId)) throw new Error('新导入运行 ID 已存在')
      const fenced = db().prepare(`
        UPDATE import_runs
        SET resumable = 0, cancel_requested = 0, last_error = 'Restarted by user',
            execution_owner = '', execution_epoch = execution_epoch + 1, lease_expires_at = 0,
            updated_at = datetime('now')
        WHERE id = ? AND execution_epoch = ?
      `).run(runId, source.execution_epoch)
      if (fenced.changes !== 1) throw new Error('导入运行重新开始时已被其他执行器接管')
      const restartStage = source.stage
      const restartingParsing = restartStage === 'parsing'
      db().prepare(`
        INSERT INTO import_runs (
          id, purpose, root_run_id, effect_namespace, source_fingerprint, manifest_fingerprint,
          authority_fingerprint, legacy_source_fingerprint, source_display_json, locale,
          stage, status, total_chapters, total_content_size, completed_chapters, base_run_id
          , manifest_chapter_count, manifest_content_size, manifest_word_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, 0, ?, ?, ?, ?)
      `).run(
        normalizedNextId,
        source.purpose,
        source.root_run_id,
        `import:${source.purpose}:${normalizedNextId}`,
        source.source_fingerprint,
        restartingParsing ? '0'.repeat(64) : source.manifest_fingerprint,
        source.authority_fingerprint,
        source.legacy_source_fingerprint,
        source.source_display_json,
        source.locale,
        restartStage,
        restartingParsing ? 0 : source.total_chapters,
        restartingParsing ? 0 : source.total_content_size,
        restartingParsing ? null : source.base_run_id,
        restartingParsing ? 0 : source.manifest_chapter_count,
        restartingParsing ? 0 : source.manifest_content_size,
        restartingParsing ? 0 : source.manifest_word_count,
      )
      if (restartingParsing) {
        db().prepare(`
          INSERT INTO import_run_sources (
            run_id, source_index, source_id, source_fingerprint, legacy_source_fingerprint, display_json, status,
            manifest_fingerprint, chapter_count, content_size, word_count, last_error
          )
          SELECT ?, source_index, source_id, source_fingerprint, legacy_source_fingerprint, display_json,
                 'pending', '', 0, 0, 0,
                 ''
          FROM import_run_sources WHERE run_id = ? ORDER BY source_index
        `).run(normalizedNextId, runId)
      } else {
        db().prepare(`
          INSERT INTO import_run_sources (
            run_id, source_index, source_id, source_fingerprint, legacy_source_fingerprint, display_json, status,
            manifest_fingerprint, chapter_count, content_size, word_count, last_error
          )
          SELECT ?, source_index, source_id, source_fingerprint, legacy_source_fingerprint, display_json, status,
                 manifest_fingerprint, chapter_count, content_size, word_count, last_error
          FROM import_run_sources WHERE run_id = ? ORDER BY source_index
        `).run(normalizedNextId, runId)
        db().prepare(`
          INSERT INTO import_run_chapters (
            run_id, chapter_number, source_id, source_chapter_number,
            title, content_fingerprint, content_size, content_snapshot
          )
          SELECT ?, chapter_number, source_id, source_chapter_number,
                 title, content_fingerprint, content_size, content_snapshot
          FROM import_run_chapters WHERE run_id = ? ORDER BY chapter_number
        `).run(normalizedNextId, runId)
      }
      return getRun(normalizedNextId)!
    })()
  }

export function requestCancel(runId: string, execution: ImportRunExecutionLease): ImportRunSnapshot {
    assertExecution(runId, execution)
    const result = db().prepare(`
      UPDATE import_runs SET cancel_requested = 1, updated_at = datetime('now')
      WHERE id = ? AND status IN ('ready', 'running')
    `).run(runId)
    if (result.changes === 0) throw new Error('导入运行当前不可取消')
    return getRun(runId)!
  }

export function cancelAtBoundary(runId: string, execution: ImportRunExecutionLease): ImportRunSnapshot {
    return db().transaction(() => {
      assertExecution(runId, execution)
      const result = db().prepare(`
        UPDATE import_runs
        SET status = 'cancelled', resumable = 1, cancel_requested = 1,
            execution_owner = '', execution_epoch = execution_epoch + 1, lease_expires_at = 0,
            updated_at = datetime('now')
        WHERE id = ? AND status IN ('ready', 'running', 'failed')
      `).run(runId)
      if (result.changes === 0) throw new Error('导入运行当前不可在安全边界取消')
      return getRun(runId)!
    })()
  }

export function completeBatch(runId: string, stage: ImportRunStage, batchId: string, execution: ImportRunExecutionLease): {
    newlyCompleted: boolean
    cancelApplied: boolean
    run: ImportRunSnapshot
  } {
    if (!batchId.trim() || batchId.length > 160) throw new Error('导入批次 ID 无效')
    return db().transaction(() => {
      const row = assertExecution(runId, execution)
      const { newlyCompleted, cancelApplied } = applyBatchCheckpoint(row, stage, batchId, 'direct')
      return { newlyCompleted, cancelApplied, run: getRun(runId)! }
    })()
  }

export function advanceStage(runId: string, completedStage: ImportRunStage, nextStage: ImportRunStage, execution: ImportRunExecutionLease): ImportRunSnapshot {
    return db().transaction(() => {
      const row = assertExecution(runId, execution)
      if (row.status !== 'running' || row.stage !== completedStage) {
        throw new Error('导入阶段与当前阶段不匹配')
      }
      if (nextStageForRun(row, completedStage) !== nextStage) throw new Error('导入下一阶段转换无效')
      assertStageCheckpointComplete(row, completedStage)
      const completedChapters = completedStage === 'blueprints' || completedStage === 'author-postprocess'
        ? row.total_chapters
        : row.completed_chapters
      const result = db().prepare(`
        UPDATE import_runs
        SET stage = ?, completed_chapters = ?, status = 'running', last_error = '',
            resumable = 1, updated_at = datetime('now')
        WHERE id = ? AND stage = ? AND status = 'running'
      `).run(nextStage, completedChapters, runId, completedStage)
      if (result.changes !== 1) throw new Error('导入阶段转换已过期')
      return getRun(runId)!
    })()
  }

export function fail(runId: string, stage: ImportRunStage, error: string, execution: ImportRunExecutionLease): ImportRunSnapshot {
    return db().transaction(() => {
      const row = assertExecution(runId, execution)
      if (row.status !== 'running' || row.stage !== stage) throw new Error('导入失败阶段与当前阶段不匹配')
      if (typeof error !== 'string') throw new Error('导入失败原因无效')
      const result = db().prepare(`
        UPDATE import_runs
        SET status = 'failed', last_error = ?, resumable = 1,
            execution_owner = '', execution_epoch = execution_epoch + 1, lease_expires_at = 0,
            updated_at = datetime('now') WHERE id = ? AND stage = ? AND status = 'running'
      `).run(error.slice(0, 2_000), runId, stage)
      if (result.changes === 0) throw new Error('导入运行当前不可标记失败')
      return getRun(runId)!
    })()
  }

export function complete(runId: string, execution: ImportRunExecutionLease): ImportRunSnapshot {
    return db().transaction(() => {
      const row = assertExecution(runId, execution)
      if (row.status !== 'running' || row.stage !== 'refresh') {
        throw new Error('导入运行只能从 refresh 刷新阶段完成')
      }
      assertStageCheckpointComplete(row, 'refresh')
      const result = db().prepare(`
        UPDATE import_runs
        SET stage = 'completed', status = 'completed', completed_chapters = total_chapters,
            resumable = 0, cancel_requested = 0, last_error = '',
            execution_owner = '', execution_epoch = execution_epoch + 1, lease_expires_at = 0,
            completed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND stage = 'refresh' AND status = 'running'
      `).run(runId)
      if (result.changes === 0) throw new Error('导入运行当前不可完成')
      return getRun(runId)!
    })()
  }
