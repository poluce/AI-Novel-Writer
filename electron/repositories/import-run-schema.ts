import { createHash } from 'node:crypto'
import { parseImportRunChapterBatchCheckpointId } from '../../src/shared/import-run'
import type {
  ImportPurpose,
  ImportRunEffectKind,
  ImportRunStage,
} from '../../src/shared/import-run'
import type { ImportRunRow, NormalizedImportRunChapter } from './import-run-store'

export const SHA256 = /^[a-f0-9]{64}$/u

export const MAX_EFFECT_RECEIPT_PAYLOAD_BYTES = 16 * 1024 * 1024

export function canonicalManifest(purpose: ImportPurpose, chapters: NormalizedImportRunChapter[]): string {
  return JSON.stringify({ purpose, chapters: chapters.map(chapter => ({
    number: chapter.number,
    sourceId: chapter.sourceId,
    sourceChapterNumber: chapter.sourceChapterNumber,
    title: chapter.title,
    contentFingerprint: chapter.contentFingerprint,
    contentSize: chapter.contentSize,
  })) })
}

export function hashManifest(purpose: ImportPurpose, chapters: NormalizedImportRunChapter[]): string {
  return createHash('sha256').update(canonicalManifest(purpose, chapters), 'utf8').digest('hex')
}

export function parseJson<T>(source: string, fallback: T): T {
  try {
    return JSON.parse(source) as T
  } catch {
    return fallback
  }
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  )
}

export function canonicalPayload(payload: unknown): { json: string; hash: string } {
  if (!payload || typeof payload !== 'object') throw new Error('导入 effect receipt 载荷无效')
  const json = JSON.stringify(canonicalize(payload))
  if (Buffer.byteLength(json, 'utf8') > MAX_EFFECT_RECEIPT_PAYLOAD_BYTES) {
    throw new Error('导入 effect receipt 载荷超过安全上限')
  }
  return { json, hash: createHash('sha256').update(json, 'utf8').digest('hex') }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index])
}

export function assertEffectPayloadSchema(kind: ImportRunEffectKind, payload: unknown): void {
  if (!isRecord(payload)) throw new Error()
  if (kind === 'author-finalized-batch') {
    if (
      !exactKeys(payload, ['operationId', 'runId', 'authorityFingerprint', 'manifestFingerprint'])
      || typeof payload.operationId !== 'string'
      || typeof payload.runId !== 'string'
      || !SHA256.test(String(payload.authorityFingerprint))
      || !SHA256.test(String(payload.manifestFingerprint))
    ) throw new Error()
    return
  }
  if (kind === 'project-writing-style') {
    if (!exactKeys(payload, ['writingStyle']) || typeof payload.writingStyle !== 'string' || !payload.writingStyle.trim()) {
      throw new Error()
    }
    return
  }
  if (kind === 'project-global-facts') {
    if (
      !exactKeys(payload, ['operationId', 'expectedRosterRevision', 'core', 'characterEntries'])
      || typeof payload.operationId !== 'string'
      || !Number.isSafeInteger(payload.expectedRosterRevision)
      || !isRecord(payload.core)
      || !Array.isArray(payload.characterEntries)
      || payload.characterEntries.length === 0
    ) throw new Error()
    return
  }
  if (
    !exactKeys(payload, ['mode', 'operationId', 'startChapter', 'endChapter', 'blueprints'])
    || payload.mode !== 'replace-range'
    || typeof payload.operationId !== 'string'
    || !Number.isSafeInteger(payload.startChapter)
    || !Number.isSafeInteger(payload.endChapter)
    || !Array.isArray(payload.blueprints)
    || payload.blueprints.length === 0
  ) throw new Error()
}

export function assertEffectPayloadBinding(
  kind: ImportRunEffectKind,
  runId: string,
  batchId: string,
  payload: unknown,
): void {
  if (kind === 'author-finalized-batch') {
    if (batchId !== 'done') throw new Error()
    return
  }
  if (kind === 'project-global-facts') {
    if (!isRecord(payload) || payload.operationId !== `novel-import-global-${runId}`) throw new Error()
    return
  }
  if (kind !== 'chapter-blueprint-range') return
  const checkpoint = parseImportRunChapterBatchCheckpointId(batchId)
  if (
    !checkpoint
    || !isRecord(payload)
    || payload.startChapter !== checkpoint.startChapter
    || payload.endChapter !== checkpoint.endChapter
    || payload.operationId !== `import-blueprints-${runId}-${checkpoint.startChapter}-${checkpoint.endChapter}`
  ) throw new Error()
}

export function assertAuthorEffectRunBinding(
  run: ImportRunRow,
  kind: ImportRunEffectKind,
  payload: unknown,
  allowCommittedLaterStage = false,
): void {
  if (kind !== 'author-finalized-batch') return
  const stageMatches = run.stage === 'author-commit'
    || (allowCommittedLaterStage && [
      'author-publish', 'author-postprocess', 'refresh', 'completed',
    ].includes(run.stage))
  if (
    run.purpose !== 'author-manuscript'
    || !stageMatches
    || !isRecord(payload)
    || payload.runId !== run.id
    || payload.operationId !== `author-import:${run.id}`
    || payload.authorityFingerprint !== run.authority_fingerprint
    || payload.manifestFingerprint !== run.manifest_fingerprint
  ) throw new Error('作者原稿提交 receipt 未绑定冻结导入运行')
}

export function assertCommittedEffectSchema(kind: ImportRunEffectKind, payload: unknown, effectReceipt: unknown): void {
  if (!isRecord(payload) || !isRecord(effectReceipt)) throw new Error()
  if (kind === 'author-finalized-batch') {
    if (
      effectReceipt.operationId !== payload.operationId
      || typeof effectReceipt.payloadHash !== 'string'
      || !Array.isArray(effectReceipt.chapterNumbers)
      || !Array.isArray(effectReceipt.drafts)
      || effectReceipt.chapterNumbers.length !== effectReceipt.drafts.length
    ) throw new Error()
    return
  }
  if (kind === 'project-writing-style') {
    if (!exactKeys(effectReceipt, ['writingStyle']) || effectReceipt.writingStyle !== payload.writingStyle) throw new Error()
    return
  }
  if (kind === 'project-global-facts') {
    if (
      !exactKeys(effectReceipt, ['operationId', 'payloadHash', 'idempotent', 'core', 'roster'])
      || effectReceipt.operationId !== payload.operationId
      || typeof effectReceipt.payloadHash !== 'string'
      || typeof effectReceipt.idempotent !== 'boolean'
      || !isRecord(effectReceipt.core)
      || !isRecord(effectReceipt.roster)
    ) throw new Error()
    return
  }
  if (
    !exactKeys(effectReceipt, [
      'mode', 'operationId', 'payloadHash', 'idempotent', 'startChapter', 'endChapter',
      'chapterNumbers', 'snapshot', 'characterSyncInput', 'characterSyncOperation',
    ])
    || effectReceipt.operationId !== payload.operationId
    || effectReceipt.mode !== payload.mode
    || effectReceipt.startChapter !== payload.startChapter
    || effectReceipt.endChapter !== payload.endChapter
    || typeof effectReceipt.payloadHash !== 'string'
    || typeof effectReceipt.idempotent !== 'boolean'
    || !Array.isArray(effectReceipt.chapterNumbers)
    || !Array.isArray(effectReceipt.snapshot)
    || !Array.isArray(effectReceipt.characterSyncInput)
    || !isRecord(effectReceipt.characterSyncOperation)
  ) throw new Error()
}

export const BLUEPRINT_SYNC_BASE_KEYS = [
  'operationId', 'blueprintCommitOperationId', 'blueprintCommitPayloadHash',
  'status', 'startChapter', 'endChapter', 'characterSyncInput', 'createdAt', 'updatedAt',
] as const

export function canonicalEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
}

export function assertCompletedBlueprintSyncOperation(operation: Record<string, unknown>): void {
  if (
    operation.status !== 'completed'
    || typeof operation.completedAt !== 'string'
    || !operation.completedAt
    || !isRecord(operation.completionReceipt)
  ) throw new Error()

  const completion = operation.completionReceipt
  if (
    completion.operationId !== operation.operationId
    || completion.blueprintCommitOperationId !== operation.blueprintCommitOperationId
  ) throw new Error()

  if (completion.status === 'already-satisfied') {
    if (!exactKeys(completion, ['blueprintCommitOperationId', 'operationId', 'status'])) throw new Error()
    return
  }
  if (
    completion.status !== 'committed'
    || !exactKeys(completion, ['blueprintCommitOperationId', 'operationId', 'status', 'rosterReceipt'])
    || !isRecord(completion.rosterReceipt)
  ) throw new Error()
  const rosterReceipt = completion.rosterReceipt
  if (
    !exactKeys(rosterReceipt, ['operationId', 'payloadHash', 'revision', 'idempotent'])
    || rosterReceipt.operationId !== operation.operationId
    || typeof rosterReceipt.payloadHash !== 'string'
    || !SHA256.test(rosterReceipt.payloadHash)
    || !Number.isInteger(rosterReceipt.revision)
    || Number(rosterReceipt.revision) < 1
    || typeof rosterReceipt.idempotent !== 'boolean'
  ) throw new Error()
}

export function assertBlueprintEffectAuthority(
  stored: Record<string, unknown>,
  authoritative: Record<string, unknown>,
): void {
  const storedSync = stored.characterSyncOperation
  const authoritativeSync = authoritative.characterSyncOperation
  if (!isRecord(storedSync) || !isRecord(authoritativeSync)) throw new Error()

  const storedOuter: Record<string, unknown> = { ...stored, idempotent: false }
  const authoritativeOuter: Record<string, unknown> = { ...authoritative, idempotent: false }
  delete storedOuter.characterSyncOperation
  delete authoritativeOuter.characterSyncOperation
  if (!canonicalEqual(storedOuter, authoritativeOuter)) throw new Error()

  const syncBinding = (operation: Record<string, unknown>) => ({
    operationId: operation.operationId,
    blueprintCommitOperationId: operation.blueprintCommitOperationId,
    blueprintCommitPayloadHash: operation.blueprintCommitPayloadHash,
    startChapter: operation.startChapter,
    endChapter: operation.endChapter,
    characterSyncInput: operation.characterSyncInput,
    createdAt: operation.createdAt,
  })
  if (!canonicalEqual(syncBinding(storedSync), syncBinding(authoritativeSync))) throw new Error()

  const storedKeys = storedSync.status === 'completed'
    ? [...BLUEPRINT_SYNC_BASE_KEYS, 'completionReceipt', 'completedAt']
    : BLUEPRINT_SYNC_BASE_KEYS
  const authoritativeKeys = authoritativeSync.status === 'completed'
    ? [...BLUEPRINT_SYNC_BASE_KEYS, 'completionReceipt', 'completedAt']
    : BLUEPRINT_SYNC_BASE_KEYS
  if (!exactKeys(storedSync, storedKeys) || !exactKeys(authoritativeSync, authoritativeKeys)) throw new Error()

  if (storedSync.status === authoritativeSync.status) {
    if (!canonicalEqual(storedSync, authoritativeSync)) throw new Error()
    return
  }
  if (storedSync.status !== 'pending' || authoritativeSync.status !== 'completed') throw new Error()
  if (storedSync.updatedAt !== authoritativeSync.createdAt) throw new Error()
  assertCompletedBlueprintSyncOperation(authoritativeSync)
}

export function validateEffectStage(kind: ImportRunEffectKind, stage: ImportRunStage): void {
  const expected: Record<ImportRunEffectKind, ImportRunStage> = {
    'project-global-facts': 'global',
    'project-writing-style': 'style',
    'chapter-blueprint-range': 'blueprints',
    'author-finalized-batch': 'author-commit',
  }
  if (expected[kind] !== stage) throw new Error('导入 effect receipt 类型与阶段不匹配')
}
