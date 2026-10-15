import { countDraftUnits } from '../../src/shared/draft-units'
import {
  assertImportRunEffectReceiptMetadata,
  IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION,
} from '../../src/shared/import-run'
import type {
  ImportGlobalFactsRequest,
} from '../../src/shared/import-global-facts'
import type {
  ImportRunEffectCommitResult,
  ImportRunEffectKind,
  ImportRunEffectReceipt,
  ImportRunExecutionLease,
  ImportRunPrepareEffectReceiptRequest,
  ImportRunStage,
} from '../../src/shared/import-run'
import { getCurrentProjectPath } from '../database'
import { BlueprintRepository, type BlueprintRangeCommitRequest } from './blueprint-repository'
import { ImportGlobalFactsRepository } from './import-global-facts-repository'
import { ProjectCoreRepository } from './project-core-repository'
import { FinalizedDraftImportRepository } from './finalized-draft-import-repository'
import { StudyDossierRepository } from './study-dossier-repository'
import {
  canonicalPayload,
  parseJson,
  assertAuthorEffectRunBinding,
  assertEffectPayloadSchema,
  assertEffectPayloadBinding,
  assertCommittedEffectSchema,
  assertBlueprintEffectAuthority,
  canonicalize,
  isRecord,
  validateEffectStage,
} from './import-run-schema'
import {
  db,
  getRun,
  readRunRow,
  rowToSnapshot,
  chapterRowToSnapshot,
  assertCheckpointCanApply,
  assertExecution,
  applyBatchCheckpoint,
  type ImportRunRow,
  type ImportRunChapterRow,
  type ImportRunEffectReceiptRow,
} from './import-run-store'

export function assertCommittedEffectAuthority(
  kind: ImportRunEffectKind,
  payload: unknown,
  effectReceipt: unknown,
): void {
  if (kind === 'project-writing-style') return
  if (!isRecord(effectReceipt)) throw new Error()
  if (kind === 'author-finalized-batch') {
    if (!isRecord(payload) || typeof payload.operationId !== 'string' || typeof payload.runId !== 'string') throw new Error()
    const chapters = (db().prepare(`
      SELECT chapter_number, source_id, source_chapter_number,
             title, content_fingerprint, content_size, content_snapshot
      FROM import_run_chapters WHERE run_id = ? ORDER BY chapter_number ASC
    `).all(payload.runId) as ImportRunChapterRow[]).map(chapterRowToSnapshot).map(chapter => ({
      chapterNumber: chapter.number,
      title: chapter.title,
      content: chapter.content,
      wordCount: countDraftUnits(chapter.content),
    }))
    const authoritative = FinalizedDraftImportRepository.getCommittedOperation(payload.operationId, chapters)
    if (!authoritative || JSON.stringify(canonicalize(authoritative)) !== JSON.stringify(canonicalize(effectReceipt))) {
      throw new Error()
    }
    return
  }
  const authoritative = kind === 'project-global-facts'
    ? ImportGlobalFactsRepository.getCommittedOperation((payload as ImportGlobalFactsRequest).operationId)
    : BlueprintRepository.getCommittedRangeOperation((payload as BlueprintRangeCommitRequest).operationId)
  if (!authoritative) throw new Error()
  if (kind === 'chapter-blueprint-range') {
    assertBlueprintEffectAuthority(effectReceipt, authoritative as unknown as Record<string, unknown>)
    return
  }
  const stored = canonicalize({ ...effectReceipt, idempotent: false })
  const readBack = canonicalize({ ...authoritative, idempotent: false })
  if (JSON.stringify(stored) !== JSON.stringify(readBack)) throw new Error()
}

export function corruptedReceipt(): never {
  throw new Error('导入 effect receipt 损坏，已拒绝重放')
}

export function rowToEffectReceipt(row: ImportRunEffectReceiptRow, run: ImportRunRow): ImportRunEffectReceipt {
  try {
    if (row.state !== 'prepared' && row.state !== 'committed') corruptedReceipt()
    const payload = JSON.parse(row.payload_json) as unknown
    const canonical = canonicalPayload(payload)
    if (canonical.json !== row.payload_json || canonical.hash !== row.payload_hash) corruptedReceipt()
    assertEffectPayloadSchema(row.kind, payload)
    assertEffectPayloadBinding(row.kind, row.run_id, row.batch_id, payload)
    assertAuthorEffectRunBinding(run, row.kind, payload, row.state === 'committed')
    const effectReceipt = row.effect_receipt_json ? JSON.parse(row.effect_receipt_json) as unknown : undefined
    if ((row.state === 'prepared' && effectReceipt !== undefined) || (row.state === 'committed' && effectReceipt === undefined)) {
      corruptedReceipt()
    }
    if (row.state === 'committed') {
      assertCommittedEffectSchema(row.kind, payload, effectReceipt)
      assertCommittedEffectAuthority(row.kind, payload, effectReceipt)
    }
    const receipt: ImportRunEffectReceipt = {
      schemaVersion: row.schema_version as typeof IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION,
      runId: row.run_id,
      effectNamespace: row.effect_namespace,
      effectKey: row.effect_key,
      stage: row.stage,
      batchId: row.batch_id,
      kind: row.kind,
      payloadHash: row.payload_hash,
      state: row.state,
      payload,
      effectReceipt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
    assertImportRunEffectReceiptMetadata(receipt, rowToSnapshot(run))
    return receipt
  } catch (error) {
    if (error instanceof Error && error.message.includes('receipt 损坏')) throw error
    return corruptedReceipt()
  }
}

export function getEffectReceipt(
    runId: string,
    stage: ImportRunStage,
    batchId: string,
  ): ImportRunEffectReceipt | null {
    const row = db().prepare(`
      SELECT * FROM import_run_receipts
      WHERE run_id = ? AND stage = ? AND batch_id = ?
    `).get(runId, stage, batchId) as ImportRunEffectReceiptRow | undefined
    if (!row) return null
    const run = readRunRow(runId)
    if (!run) return corruptedReceipt()
    return rowToEffectReceipt(row, run)
  }

export function prepareEffectReceipt(
    request: ImportRunPrepareEffectReceiptRequest,
    execution: ImportRunExecutionLease,
    now = Date.now(),
  ): ImportRunEffectReceipt {
    const effectKey = request.effectKey?.trim()
    const batchId = request.batchId?.trim()
    if (!effectKey || effectKey.length > 200 || !batchId || batchId.length > 160) {
      throw new Error('导入 effect receipt 键无效')
    }
    validateEffectStage(request.kind, request.stage)
    const payload = canonicalPayload(request.payload)
    return db().transaction(() => {
      const run = assertExecution(request.runId, execution, now)
      assertAuthorEffectRunBinding(run, request.kind, request.payload)
      assertCheckpointCanApply(run, request.stage, batchId, 'receipt')
      const existing = db().prepare(`
        SELECT * FROM import_run_receipts
        WHERE run_id = ? AND stage = ? AND batch_id = ?
      `).get(request.runId, request.stage, batchId) as ImportRunEffectReceiptRow | undefined
      if (existing) {
        if (
          existing.effect_namespace !== run.effect_namespace
          || existing.effect_key !== effectKey
          || existing.kind !== request.kind
          || existing.payload_hash !== payload.hash
        ) throw new Error('导入 effect receipt 已绑定不同载荷')
        return rowToEffectReceipt(existing, run)
      }
      db().prepare(`
        INSERT INTO import_run_receipts (
          run_id, schema_version, effect_namespace, effect_key, stage, batch_id, kind, payload_json, payload_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        request.runId,
        IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION,
        run.effect_namespace,
        effectKey,
        request.stage,
        batchId,
        request.kind,
        payload.json,
        payload.hash,
      )
      return getEffectReceipt(request.runId, request.stage, batchId)!
    })()
  }

export function commitEffectReceipt(
    runId: string,
    stage: ImportRunStage,
    batchId: string,
    execution: ImportRunExecutionLease,
    now = Date.now(),
  ): ImportRunEffectCommitResult {
    return db().transaction(() => {
      const run = assertExecution(runId, execution, now)
      const row = db().prepare(`
        SELECT * FROM import_run_receipts
        WHERE run_id = ? AND stage = ? AND batch_id = ?
      `).get(runId, stage, batchId) as ImportRunEffectReceiptRow | undefined
      if (!row) throw new Error('导入 effect receipt 不存在')
      assertCheckpointCanApply(run, stage, batchId, 'receipt')
      const validatedReceipt = rowToEffectReceipt(row, run)
      if (row.state === 'committed') {
        return {
          receipt: validatedReceipt,
          run: getRun(runId)!,
          cancelApplied: run.cancel_requested === 1,
        }
      }
      let effectReceipt: unknown
      switch (row.kind) {
        case 'project-global-facts':
          effectReceipt = ImportGlobalFactsRepository.commit(
            parseJson<ImportGlobalFactsRequest>(row.payload_json, {} as ImportGlobalFactsRequest),
          )
          break
        case 'project-writing-style': {
          const payload = parseJson<{ writingStyle?: unknown }>(row.payload_json, {})
          if (typeof payload.writingStyle !== 'string' || !payload.writingStyle.trim()) {
            throw new Error('导入文风 receipt 载荷无效')
          }
          ProjectCoreRepository.update({ writingStyle: payload.writingStyle.trim() })
          effectReceipt = { writingStyle: payload.writingStyle.trim() }
          break
        }
        case 'chapter-blueprint-range':
          effectReceipt = BlueprintRepository.commitRange(
            parseJson<BlueprintRangeCommitRequest>(row.payload_json, {} as BlueprintRangeCommitRequest),
          )
          break
        case 'author-finalized-batch': {
          assertAuthorEffectRunBinding(run, row.kind, validatedReceipt.payload)
          const projectRoot = getCurrentProjectPath()
          if (!projectRoot) throw new Error('项目数据库未打开')
          const chapters = (db().prepare(`
            SELECT chapter_number, source_id, source_chapter_number,
                   title, content_fingerprint, content_size, content_snapshot
            FROM import_run_chapters WHERE run_id = ? ORDER BY chapter_number ASC
          `).all(runId) as ImportRunChapterRow[]).map(chapterRowToSnapshot).map(chapter => ({
            chapterNumber: chapter.number,
            title: chapter.title,
            content: chapter.content,
            wordCount: countDraftUnits(chapter.content),
          }))
          const commitManifestFingerprint = FinalizedDraftImportRepository.preview(chapters).manifestFingerprint
          effectReceipt = FinalizedDraftImportRepository.commit(projectRoot, {
            operationId: `author-import:${runId}`,
            expectedAuthorityFingerprint: run.authority_fingerprint,
            expectedManifestFingerprint: run.manifest_fingerprint,
            expectedCommitManifestFingerprint: commitManifestFingerprint,
            chapters,
          })
          break
        }
        default:
          throw new Error('导入 effect receipt 类型不受支持')
      }
      if (run.purpose !== 'author-manuscript') {
        StudyDossierRepository.updateFromImportEffect(runId, row.kind, row.payload_json)
      }
      const checkpoint = applyBatchCheckpoint(run, stage, batchId, 'receipt')
      db().prepare(`
        UPDATE import_run_receipts
        SET state = 'committed', effect_receipt_json = ?, updated_at = datetime('now')
        WHERE run_id = ? AND stage = ? AND batch_id = ? AND state = 'prepared'
      `).run(JSON.stringify(effectReceipt), runId, stage, batchId)
      return {
        receipt: getEffectReceipt(runId, stage, batchId)!,
        run: getRun(runId)!,
        cancelApplied: checkpoint.cancelApplied,
      }
    })()
  }
