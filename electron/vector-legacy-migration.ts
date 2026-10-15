/**
 * One-way migration from legacy vectors.json into LanceDB document writes.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  DEFAULT_DISTANCE_METRIC,
  DOCS_TABLE_NAME,
  EMBEDDING_TABLE_PREFIX,
  TABLE_NAME,
  getConnection,
  legacyMigrationJournalPath,
  registryPath,
} from './vector-connection'
import {
  validateChunks,
  validateVectorsForChunks,
} from './vector-schema'
import {
  activeSpace,
  inferLegacyRegistry,
  matchingSpace,
  normalizedIdentity,
  readRegistry,
  writeJsonAtomically,
} from './embedding-registry'
import {
  addChunks,
  removeDocument,
} from './vector-documents'

const legacyMigrationInFlight = new Map<string, Promise<{ success: boolean; migrated: number; error?: string }>>()

interface LegacyVectorJsonDocument {
  id?: unknown
  fileName?: unknown
  filePath?: unknown
}

interface LegacyVectorJsonEntry {
  docId?: unknown
  text?: unknown
  vector?: unknown
  meta?: {
    fileName?: unknown
  }
}

interface LegacyMigrationDocument {
  docId: string
  fileName: string
  filePath?: string
  chunks: string[]
  vectors?: number[][]
}

interface LegacyMigrationPlan {
  documents: LegacyMigrationDocument[]
  migratedChunks: number
  vectorDimension?: number
}

interface LegacyMigrationJournal {
  version: 1
  sourceDigest: string
  docIds: string[]
  tableNamesBefore: string[]
  registryBefore?: string
}

function legacyMigrationError(detail: string): string {
  return `旧向量数据迁移未完成：${detail}。为防止知识库重复或损坏，导入、检索和向量回填已暂停；请修正 .vela/vectors.json 后重试。`
}

function legacySourceDigest(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}

function readLegacyMigrationJournal(projectPath: string): LegacyMigrationJournal | undefined {
  const filePath = legacyMigrationJournalPath(projectPath)
  if (!fs.existsSync(filePath)) return undefined
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<LegacyMigrationJournal>
    if (
      value.version !== 1
      || typeof value.sourceDigest !== 'string'
      || !/^[a-f0-9]{64}$/i.test(value.sourceDigest)
      || !Array.isArray(value.docIds)
      || value.docIds.some(docId => typeof docId !== 'string' || !docId)
      || !Array.isArray(value.tableNamesBefore)
      || value.tableNamesBefore.some(tableName => typeof tableName !== 'string' || !tableName)
      || (value.registryBefore !== undefined && typeof value.registryBefore !== 'string')
    ) {
      throw new Error('格式无效')
    }
    return {
      version: 1,
      sourceDigest: value.sourceDigest,
      docIds: [...value.docIds],
      tableNamesBefore: [...value.tableNamesBefore],
      registryBefore: value.registryBefore,
    }
  } catch {
    throw new Error(legacyMigrationError('检测到损坏的迁移恢复记录，未修改任何知识库数据'))
  }
}

function writeLegacyMigrationJournal(projectPath: string, journal: LegacyMigrationJournal): void {
  writeJsonAtomically(legacyMigrationJournalPath(projectPath), journal)
}

function removeLegacyMigrationJournal(projectPath: string): void {
  fs.rmSync(legacyMigrationJournalPath(projectPath), { force: true })
}

function createLegacyMigrationPlan(raw: string): LegacyMigrationPlan | { error: string } {
  let source: { documents?: unknown; entries?: unknown }
  try {
    source = JSON.parse(raw) as { documents?: unknown; entries?: unknown }
  } catch {
    return { error: legacyMigrationError('vectors.json 不是有效 JSON') }
  }
  if (source.entries !== undefined && !Array.isArray(source.entries)) {
    return { error: legacyMigrationError('vectors.json 的 entries 格式无效') }
  }
  if (source.documents !== undefined && !Array.isArray(source.documents)) {
    return { error: legacyMigrationError('vectors.json 的 documents 格式无效') }
  }

  const documentInfo = new Map<string, LegacyVectorJsonDocument>()
  for (const value of (source.documents ?? []) as LegacyVectorJsonDocument[]) {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id) {
      return { error: legacyMigrationError('vectors.json 含有无效文档标识') }
    }
    if (documentInfo.has(value.id)) {
      return { error: legacyMigrationError(`vectors.json 含有重复文档标识：${value.id}`) }
    }
    documentInfo.set(value.id, value)
  }

  const byDocument = new Map<string, LegacyVectorJsonEntry[]>()
  for (const value of (source.entries ?? []) as LegacyVectorJsonEntry[]) {
    if (!value || typeof value !== 'object' || typeof value.docId !== 'string' || !value.docId) {
      return { error: legacyMigrationError('vectors.json 含有无效块的文档标识') }
    }
    if (typeof value.text !== 'string') {
      return { error: legacyMigrationError(`文档 ${value.docId} 含有无效文本块`) }
    }
    const entries = byDocument.get(value.docId) ?? []
    entries.push(value)
    byDocument.set(value.docId, entries)
  }

  const documents: LegacyMigrationDocument[] = []
  let vectorDimension: number | undefined
  let includesVectors = false
  let includesVectorlessDocuments = false
  const fileNames = new Set<string>()
  for (const [docId, entries] of byDocument) {
    const info = documentInfo.get(docId)
    const metaFileName = entries[0]?.meta && typeof entries[0].meta.fileName === 'string'
      ? entries[0].meta.fileName
      : undefined
    const fileName = typeof info?.fileName === 'string' && info.fileName
      ? info.fileName
      : metaFileName || 'unknown'
    if (fileNames.has(fileName)) {
      return { error: legacyMigrationError(`vectors.json 含有重复文件名：${fileName}`) }
    }
    fileNames.add(fileName)

    const chunks = entries.map(entry => entry.text as string)
    if (!validateChunks(chunks)) {
      return { error: legacyMigrationError(`文档 ${docId} 没有可迁移文本块`) }
    }
    const rawVectors = entries.map(entry => entry.vector)
    const allMissing = rawVectors.every(vector => vector === undefined)
    if (allMissing) {
      includesVectorlessDocuments = true
      documents.push({
        docId,
        fileName,
        filePath: typeof info?.filePath === 'string' ? info.filePath : undefined,
        chunks,
      })
      continue
    }

    includesVectors = true
    const validation = validateVectorsForChunks(chunks, rawVectors)
    if (validation.error || !validation.vectors || validation.dimension === undefined) {
      return { error: legacyMigrationError(`文档 ${docId} 的向量无效：${validation.error ?? '无法建立嵌入空间'}`) }
    }
    if (vectorDimension !== undefined && vectorDimension !== validation.dimension) {
      return { error: legacyMigrationError(`旧数据混用了 ${vectorDimension} 与 ${validation.dimension} 维向量`) }
    }
    vectorDimension = validation.dimension
    documents.push({
      docId,
      fileName,
      filePath: typeof info?.filePath === 'string' ? info.filePath : undefined,
      chunks,
      vectors: validation.vectors,
    })
  }

  if (includesVectors && includesVectorlessDocuments) {
    return { error: legacyMigrationError('旧数据混合了有向量和无向量文档，无法安全建立单一嵌入空间') }
  }
  return {
    documents,
    migratedChunks: documents.reduce((count, document) => count + document.chunks.length, 0),
    vectorDimension,
  }
}

interface LegacyMigrationPreflight {
  tableNamesBefore: string[]
  registryBefore?: string
}

async function preflightLegacyMigrationTarget(
  projectPath: string,
  plan: LegacyMigrationPlan,
): Promise<LegacyMigrationPreflight | { error: string }> {
  if (plan.documents.length === 0) return { tableNamesBefore: [] }
  const db = await getConnection(projectPath)
  const tableNames = await db.tableNames()
  const registryFile = registryPath(projectPath)
  const registryBefore = fs.existsSync(registryFile) ? fs.readFileSync(registryFile, 'utf8') : undefined
  const preflight = { tableNamesBefore: [...tableNames], registryBefore }
  const sourceDocIds = new Set(plan.documents.map(document => document.docId))
  const sourceFileNames = new Set(plan.documents.map(document => document.fileName))
  if (tableNames.includes(TABLE_NAME)) {
    const existingRows = await (await db.openTable(TABLE_NAME)).query().select(['docId']).toArray()
    if (existingRows.some(row => sourceDocIds.has(String((row as { docId?: unknown }).docId ?? '')))) {
      return { error: legacyMigrationError('发现与旧数据相同的已迁移块，未写入重复数据') }
    }
  }
  if (tableNames.includes(DOCS_TABLE_NAME)) {
    const existingDocuments = await (await db.openTable(DOCS_TABLE_NAME)).query().select(['id', 'fileName']).toArray()
    if (existingDocuments.some(row => sourceDocIds.has(String((row as { id?: unknown }).id ?? '')))) {
      return { error: legacyMigrationError('发现与旧数据相同的已迁移文档，未写入重复数据') }
    }
    if (existingDocuments.some(row => sourceFileNames.has(String((row as { fileName?: unknown }).fileName ?? '')))) {
      return { error: legacyMigrationError('现有知识库已使用同名文档，未修改任何数据') }
    }
  }
  if (plan.vectorDimension === undefined) return preflight

  // Migration preflight must not create an embedding registry. If validation
  // rejects this legacy source, the project needs to remain byte-for-byte as
  // it was before the attempt.
  const registry = readRegistry(projectPath) ?? await inferLegacyRegistry(db, tableNames)
  const identity = normalizedIdentity({ modelFingerprint: 'legacy-json', distanceMetric: DEFAULT_DISTANCE_METRIC }, plan.vectorDimension)
  const existingSpace = matchingSpace(registry, identity, plan.vectorDimension)
  const canonicalHasRows = tableNames.includes(TABLE_NAME)
    && await (await db.openTable(TABLE_NAME)).countRows() > 0
  if (!existingSpace && (registry.spaces.length > 0 || canonicalHasRows)) {
    const active = activeSpace(registry)
    const current = active
      ? `${active.modelFingerprint} / ${active.vectorDimension} 维`
      : '当前全文知识库'
    return { error: legacyMigrationError(`reindex_required: 嵌入空间与${current}不兼容，旧代际未被修改`) }
  }
  return preflight
}

function restoreLegacyRegistrySnapshot(projectPath: string, registryBefore: string | undefined): void {
  const filePath = registryPath(projectPath)
  if (registryBefore === undefined) {
    fs.rmSync(filePath, { force: true })
    return
  }
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporaryPath, registryBefore, 'utf8')
    fs.renameSync(temporaryPath, filePath)
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true })
  }
}

async function rollbackLegacyMigrationDocuments(projectPath: string, journal: LegacyMigrationJournal): Promise<boolean> {
  try {
    for (const docId of journal.docIds) {
      if (!await removeDocument(projectPath, docId)) return false
    }
    const db = await getConnection(projectPath)
    const tableNamesBefore = new Set(journal.tableNamesBefore)
    for (const tableName of await db.tableNames()) {
      const isKnowledgeTable = tableName === TABLE_NAME
        || tableName === DOCS_TABLE_NAME
        || tableName.startsWith(EMBEDDING_TABLE_PREFIX)
      if (isKnowledgeTable && !tableNamesBefore.has(tableName)) {
        await db.dropTable(tableName)
      }
    }
    restoreLegacyRegistrySnapshot(projectPath, journal.registryBefore)
    return true
  } catch (error) {
    console.warn('[Vela VectorStore] 回滚旧 vectors.json 迁移失败:', error)
    return false
  }
}

async function migrateFromJSONOnce(projectPath: string): Promise<{ success: boolean; migrated: number; error?: string }> {
  const jsonPath = path.join(projectPath, '.vela', 'vectors.json')
  const journalPath = legacyMigrationJournalPath(projectPath)
  if (!fs.existsSync(jsonPath)) {
    if (fs.existsSync(journalPath)) {
      const migratedPath = `${jsonPath}.migrated`
      try {
        const journal = readLegacyMigrationJournal(projectPath)
        if (
          journal
          && fs.existsSync(migratedPath)
          && legacySourceDigest(fs.readFileSync(migratedPath, 'utf8')) === journal.sourceDigest
        ) {
          // The source was renamed only after every document write completed.
          // A matching renamed file therefore proves commit; deleting this
          // leftover journal makes the operation idempotent after a crash.
          removeLegacyMigrationJournal(projectPath)
          return { success: true, migrated: 0 }
        }
      } catch (error) {
        return {
          success: false,
          migrated: 0,
          error: error instanceof Error ? error.message : legacyMigrationError(String(error)),
        }
      }
      return {
        success: false,
        migrated: 0,
        error: legacyMigrationError('检测到未完成迁移记录但原 vectors.json 不存在，未自动删除任何数据'),
      }
    }
    return { success: true, migrated: 0 }
  }

  try {
    const raw = fs.readFileSync(jsonPath, 'utf8')
    const plan = createLegacyMigrationPlan(raw)
    if ('error' in plan) return { success: false, migrated: 0, error: plan.error }

    const journal = readLegacyMigrationJournal(projectPath)
    if (journal) {
      const sourceDocIds = new Set(plan.documents.map(document => document.docId))
      if (journal.docIds.some(docId => !sourceDocIds.has(docId))) {
        return {
          success: false,
          migrated: 0,
          error: legacyMigrationError('检测到与当前源数据不匹配的中断迁移记录，未自动删除任何数据'),
        }
      }
      if (!await rollbackLegacyMigrationDocuments(projectPath, journal)) {
        return {
          success: false,
          migrated: 0,
          error: legacyMigrationError('无法清理上次中断迁移的临时数据，未写入新数据'),
        }
      }
      removeLegacyMigrationJournal(projectPath)
    }

    const preflight = await preflightLegacyMigrationTarget(projectPath, plan)
    if ('error' in preflight) return { success: false, migrated: 0, error: preflight.error }

    if (plan.documents.length === 0) {
      fs.renameSync(jsonPath, `${jsonPath}.migrated`)
      return { success: true, migrated: 0 }
    }

    const sourceDigest = legacySourceDigest(raw)
    const docIds = plan.documents.map(document => document.docId)
    const journalForAttempt: LegacyMigrationJournal = {
      version: 1,
      sourceDigest,
      docIds,
      tableNamesBefore: preflight.tableNamesBefore,
      registryBefore: preflight.registryBefore,
    }
    writeLegacyMigrationJournal(projectPath, journalForAttempt)
    for (const document of plan.documents) {
      const result = await addChunks(
        projectPath,
        document.docId,
        document.fileName,
        document.chunks,
        document.vectors,
        document.filePath,
        undefined,
        { modelFingerprint: 'legacy-json', distanceMetric: DEFAULT_DISTANCE_METRIC },
      )
      if (!result.success) {
        const rolledBack = await rollbackLegacyMigrationDocuments(projectPath, journalForAttempt)
        if (rolledBack) removeLegacyMigrationJournal(projectPath)
        return {
          success: false,
          migrated: 0,
          error: legacyMigrationError(result.error ?? '写入 LanceDB 失败'),
        }
      }
    }

    try {
      fs.renameSync(jsonPath, `${jsonPath}.migrated`)
    } catch (error) {
      const rolledBack = await rollbackLegacyMigrationDocuments(projectPath, journalForAttempt)
      if (rolledBack) removeLegacyMigrationJournal(projectPath)
      return {
        success: false,
        migrated: 0,
        error: legacyMigrationError(`未能标记原 vectors.json：${String(error)}`),
      }
    }
    removeLegacyMigrationJournal(projectPath)
    console.log(`[Vela VectorStore] 迁移完成：${plan.migratedChunks} 个块已写入 LanceDB`)
    return { success: true, migrated: plan.migratedChunks }
  } catch (error) {
    console.error('[Vela VectorStore] 迁移失败:', error)
    return { success: false, migrated: 0, error: legacyMigrationError(String(error)) }
  }
}

/**
 * 从旧 vectors.json 迁移数据到 LanceDB。
 * 在任意写入前验证完整源文件，并以持久 journal 回滚中断批次，避免重试重复写入。
 */
export async function migrateFromJSON(projectPath: string): Promise<{ success: boolean; migrated: number; error?: string }> {
  const key = path.resolve(projectPath)
  const running = legacyMigrationInFlight.get(key)
  if (running) return running
  const migration = migrateFromJSONOnce(projectPath)
  legacyMigrationInFlight.set(key, migration)
  try {
    return await migration
  } finally {
    if (legacyMigrationInFlight.get(key) === migration) legacyMigrationInFlight.delete(key)
  }
}
