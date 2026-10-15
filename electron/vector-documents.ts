/**
 * Canonical document and chunk writes. Does not import embedding rebuild or search.
 */
import * as lancedb from '@lancedb/lancedb'
import type { Schema as ArrowSchema } from 'apache-arrow'
import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { logFailure } from '../src/shared/fail-log'
import {
  DOCS_TABLE_NAME,
  EMBEDDING_TABLE_PREFIX,
  TABLE_NAME,
  databasePath,
  embeddingTableDirectory,
  getConnection,
  registryPath,
} from './vector-connection'
import {
  asNumberArray,
  canonicalChunkSchema,
  embeddingChunkSchema,
  recordsForSchema,
  validateChunks,
  validateVectorsForChunks,
  vectorIsUsable,
  type ChunkRecord,
  type KnowledgeCorpusKind,
} from './vector-schema'
import {
  activeSpace,
  inferLegacyRegistry,
  loadOrRegisterLegacyRegistry,
  matchingSpace,
  nextSpace,
  normalizedIdentity,
  readRegistry,
  registryWithNoActiveGeneration,
  writeRegistry,
  type EmbeddingSpace,
  type EmbeddingSpaceIdentity,
  type EmbeddingSpaceRegistry,
  type EmbeddingSpaceStatus,
} from './embedding-registry'

/** 文档元信息（聚合查询结果） */
export interface DocumentInfo {
  [key: string]: unknown
  id: string
  fileName: string
  importedAt: string
  chunkCount: number
  filePath: string
  corpusKind: KnowledgeCorpusKind
}

/** 知识库统计 */
export interface KBStats {
  documentCount: number
  totalChunks: number
  vectorDimension: number
  hasVectors: boolean
}

const embeddingTableCreationOwners = new Set<string>()

function removeEmptyUnregisteredTableDirectory(projectPath: string, tableName: string): void {
  const tableDirectory = embeddingTableDirectory(projectPath, tableName)
  if (!fs.existsSync(tableDirectory)) return
  const stat = fs.statSync(tableDirectory)
  if (!stat.isDirectory() || fs.readdirSync(tableDirectory).length > 0) {
    throw new Error(`嵌入空间 ${tableName} 存在未登记数据，已拒绝覆盖；请修复知识库后重试`)
  }
  fs.rmdirSync(tableDirectory)
}

async function cleanupOwnedTableCreation(
  projectPath: string,
  db: lancedb.Connection,
  tableName: string,
): Promise<void> {
  const registry = readRegistry(projectPath)
  if (registry?.spaces.some(space => space.tableName === tableName)) return
  try {
    if ((await db.tableNames()).includes(tableName)) {
      await db.dropTable(tableName)
    } else {
      removeEmptyUnregisteredTableDirectory(projectPath, tableName)
    }
  } catch (cleanupError) {
    console.warn(`[Vela VectorStore] 清理本次失败的嵌入表 ${tableName} 失败:`, cleanupError)
  }
}

export async function createOwnedEmbeddingTable(
  projectPath: string,
  db: lancedb.Connection,
  space: EmbeddingSpace,
  records: ReadonlyArray<Record<string, unknown>>,
  schema: ArrowSchema,
): Promise<void> {
  const ownershipKey = `${databasePath(projectPath)}\0${space.tableName}`
  if (embeddingTableCreationOwners.has(ownershipKey)) {
    throw new Error(`嵌入空间 ${space.tableName} 正在创建，请稍后重试`)
  }

  embeddingTableCreationOwners.add(ownershipKey)
  try {
    // A native createTable failure can leave an empty unregistered directory.
    // Removing only an empty exact candidate is safe and lets the same
    // generation be retried without deleting any table that contains data.
    removeEmptyUnregisteredTableDirectory(projectPath, space.tableName)
    try {
      await db.createTable(space.tableName, recordsForSchema(records, schema), { schema })
    } catch (error) {
      await cleanupOwnedTableCreation(projectPath, db, space.tableName)
      throw error
    }
  } finally {
    embeddingTableCreationOwners.delete(ownershipKey)
  }
}

async function appendCompatibleRecords(table: lancedb.Table, records: ReadonlyArray<Record<string, unknown>>): Promise<void> {
  if (records.length === 0) return
  await ensureCorpusKindColumn(table)
  const schema = await table.schema()
  await table.add(recordsForSchema(records, schema))
}

async function ensureCorpusKindColumn(table: lancedb.Table): Promise<void> {
  const schema = await table.schema()
  if (schema.fields.some(field => field.name === 'corpusKind')) return
  await table.addColumns([{ name: 'corpusKind', valueSql: "'unknown'" }])
}

async function appendCanonicalRecords(
  db: lancedb.Connection,
  tableNames: readonly string[],
  records: ReadonlyArray<ChunkRecord>,
): Promise<void> {
  if (!tableNames.includes(TABLE_NAME)) {
    await db.createTable(TABLE_NAME, recordsForSchema(records, canonicalChunkSchema()), { schema: canonicalChunkSchema() })
    return
  }
  await appendCompatibleRecords(await db.openTable(TABLE_NAME), records)
}

async function ensureTextIndex(table: lancedb.Table): Promise<void> {
  try {
    await table.createIndex('text', { config: lancedb.Index.fts() })
  } catch (error) {
    logFailure('VectorStore', 'FTS index create skipped or failed', error)
  }
}

interface EmbeddingWrite {
  space: EmbeddingSpace
  tableName: string
  newlyCreated: boolean
}

async function appendEmbeddingRecords(
  projectPath: string,
  db: lancedb.Connection,
  registry: EmbeddingSpaceRegistry,
  records: ReadonlyArray<ChunkRecord>,
  dimension: number,
  identity: Required<EmbeddingSpaceIdentity>,
): Promise<EmbeddingWrite> {
  const existing = matchingSpace(registry, identity, dimension)
  if (existing) {
    await appendCompatibleRecords(await db.openTable(existing.tableName), records)
    return { space: existing, tableName: existing.tableName, newlyCreated: false }
  }

  const space = nextSpace(registry, identity, dimension)
  await createOwnedEmbeddingTable(projectPath, db, space, records, embeddingChunkSchema(dimension))
  return { space, tableName: space.tableName, newlyCreated: true }
}

/**
 * Compensate only the physical embedding write owned by the failed operation.
 * A newly-created generation can be dropped wholesale; a pre-existing
 * generation must keep its table and all rows except the exact IDs appended by
 * this operation.  Keeping ownership explicit prevents cleanup from ever
 * dropping an old or active generation.
 */
async function compensateEmbeddingWrite(
  db: lancedb.Connection,
  write: EmbeddingWrite,
  recordIds: readonly string[],
): Promise<void> {
  try {
    const tableNames = await db.tableNames()
    if (!tableNames.includes(write.tableName)) return
    if (write.newlyCreated) {
      await db.dropTable(write.tableName)
      return
    }

    const table = await db.openTable(write.tableName)
    for (const recordId of recordIds) {
      await table.delete(`id = '${recordId.replace(/'/g, "''")}'`)
    }
  } catch (error) {
    console.warn(`[Vela VectorStore] 补偿嵌入写入 ${write.tableName} 失败:`, error)
  }
}

export async function completeForCanonicalTable(
  db: lancedb.Connection,
  space: EmbeddingSpace,
): Promise<boolean> {
  const canonicalRows = await (await db.openTable(TABLE_NAME)).query().select(['id']).toArray()
  const vectorRows = await (await db.openTable(space.tableName)).query().select(['id', 'vector']).toArray()
  const canonicalIds = canonicalRows.map(row => (row as { id?: unknown }).id)
  const vectorIds = vectorRows.map(row => (row as { id?: unknown }).id)
  if (
    canonicalRows.length !== vectorRows.length
    || canonicalIds.some(id => typeof id !== 'string' || !id)
    || vectorIds.some(id => typeof id !== 'string' || !id)
    || new Set(canonicalIds).size !== canonicalIds.length
    || new Set(vectorIds).size !== vectorIds.length
    || vectorRows.some(row => !vectorIsUsable((row as { vector?: unknown }).vector, space.vectorDimension))
  ) {
    return false
  }

  const vectorIdSet = new Set(vectorIds)
  return canonicalIds.every(id => vectorIdSet.has(id))
}

export async function verifyQueryableEmbeddingSpace(
  db: lancedb.Connection,
  space: EmbeddingSpace,
): Promise<boolean> {
  const table = await db.openTable(space.tableName)
  const rows = await table.query().select(['vector']).limit(1).toArray()
  const probe = rows[0] && asNumberArray((rows[0] as { vector?: unknown }).vector)
  if (!probe || !vectorIsUsable(probe, space.vectorDimension)) return false
  // 用真实向量做一次最小查询，确保“可读行”不是只有 Arrow schema 表面成立。
  return (await table.search(probe).limit(1).toArray()).length > 0
}

async function finaliseEmbeddingWrite(
  projectPath: string,
  db: lancedb.Connection,
  registry: EmbeddingSpaceRegistry,
  write: EmbeddingWrite,
): Promise<void> {
  if (write.newlyCreated) registry.spaces.push(write.space)
  const complete = await completeForCanonicalTable(db, write.space)
  const queryable = complete && await verifyQueryableEmbeddingSpace(db, write.space)
  if (queryable) {
    for (const space of registry.spaces) {
      if (space.generation === write.space.generation) {
        space.status = 'active'
      } else if (space.status === 'active') {
        space.status = 'inactive'
      }
    }
    registry.activeGeneration = write.space.generation
  } else {
    write.space.status = 'building'
    if (registry.activeGeneration === write.space.generation) {
      const fallback = registry.spaces.find(space => (
        space.generation !== write.space.generation && space.status === 'active'
      ))
      registry.activeGeneration = fallback?.generation ?? null
    }
  }
  // 仅在表已写入、可重新打开且完整性已验证后切换 active 指针。
  writeRegistry(projectPath, registry)
}

async function writeDocumentInfo(
  db: lancedb.Connection,
  tableNames: readonly string[],
  docInfo: DocumentInfo,
): Promise<void> {
  if (!tableNames.includes(DOCS_TABLE_NAME)) {
    await db.createTable(DOCS_TABLE_NAME, [docInfo])
    return
  }
  const docsTable = await db.openTable(DOCS_TABLE_NAME)
  await ensureCorpusKindColumn(docsTable)
  // 先追加。若后续 canonical/vector/catalog 任一步失败，旧同名文档仍然存在，
  // 回滚也只会删除本次 docId。
  await docsTable.add([docInfo])
}

async function pruneSupersededDocumentInfo(
  db: lancedb.Connection,
  docInfo: DocumentInfo,
): Promise<void> {
  try {
    const docsTable = await db.openTable(DOCS_TABLE_NAME)
    const fileName = docInfo.fileName.replace(/'/g, "''")
    const docId = docInfo.id.replace(/'/g, "''")
    const corpusKind = docInfo.corpusKind.replace(/'/g, "''")
    await docsTable.delete(`\`fileName\` = '${fileName}' AND \`corpusKind\` = '${corpusKind}' AND id != '${docId}'`)
  } catch (error) {
    // 这一步是旧元数据整理，不应将已完成的安全写入变成失败或删除新数据。
    console.warn('[Vela VectorStore] 清理同名旧文档元数据失败:', error)
  }
}

async function rollbackCurrentWrite(
  db: lancedb.Connection,
  chunkIds: readonly string[],
  docId: string,
): Promise<void> {
  try {
    const tableNames = await db.tableNames()
    const escapedDocId = docId.replace(/'/g, "''")
    for (const tableName of tableNames) {
      try {
        const table = await db.openTable(tableName)
        if (tableName === DOCS_TABLE_NAME) {
          await table.delete(`id = '${escapedDocId}'`)
        } else if (tableName === TABLE_NAME || tableName.startsWith(EMBEDDING_TABLE_PREFIX)) {
          // 以本次生成的 chunk id 精确删除，避免触碰同一 docId 的历史数据。
          for (const chunkId of chunkIds) {
            await table.delete(`id = '${chunkId.replace(/'/g, "''")}'`)
          }
        }
      } catch (error) {
        console.warn(`[Vela VectorStore] 回滚 ${tableName} 的本次写入失败:`, error)
      }
    }
  } catch (error) {
    console.warn('[Vela VectorStore] 读取回滚目标失败:', error)
  }
}

/**
 * 写入文档块到 LanceDB。
 * 文本先后均可独立检索；带向量时仅写入匹配的版本化嵌入空间。
 */
export async function addChunks(
  projectPath: string,
  docId: string,
  fileName: string,
  chunks: string[],
  vectors?: number[][],
  filePath?: string,
  metadata?: {
    chapterNumber?: number
    chapterTitle?: string
    corpusKind?: KnowledgeCorpusKind
    replacementMode?: 'by-file-name' | 'stable-id'
  },
  embeddingSpace?: EmbeddingSpaceIdentity,
): Promise<{ success: boolean; chunkCount: number; error?: string }> {
  if (!validateChunks(chunks)) {
    return { success: false, chunkCount: 0, error: '文本块为空或格式无效' }
  }
  const validation = validateVectorsForChunks(chunks, vectors)
  if (validation.error) {
    return { success: false, chunkCount: 0, error: validation.error }
  }

  let db: lancedb.Connection | undefined
  let rollbackRequired = false
  let chunkIds: string[] = []
  let embeddingWrite: EmbeddingWrite | undefined
  try {
    db = await getConnection(projectPath)
    const now = new Date().toISOString()
    const corpusKind = metadata?.corpusKind ?? 'unknown'
    const canonicalRecords: ChunkRecord[] = chunks.map((text, index) => ({
      id: randomUUID(),
      docId,
      fileName,
      text,
      chunkIndex: index,
      totalChunks: chunks.length,
      importedAt: now,
      chapterNumber: metadata?.chapterNumber,
      chapterTitle: metadata?.chapterTitle,
      corpusKind,
    }))
    chunkIds = canonicalRecords.map(record => record.id)
    const tableNames = await db.tableNames()
    const registry = await loadOrRegisterLegacyRegistry(projectPath, db, tableNames)

    if (validation.vectors && validation.dimension !== undefined) {
      const identity = normalizedIdentity(embeddingSpace, validation.dimension)
      const existingSpace = matchingSpace(registry, identity, validation.dimension)
      const canonicalHasRows = tableNames.includes(TABLE_NAME)
        && await (await db.openTable(TABLE_NAME)).countRows() > 0
      // 普通导入不能把新模型当作“顺手重建”。存在任何已知空间，或已有仅全文
      // 文本但尚未显式回填时，调用方必须进入明确的 rebuild/backfill 流程。
      if (!existingSpace && (registry.spaces.length > 0 || canonicalHasRows)) {
        const active = activeSpace(registry)
        const current = active
          ? `${active.modelFingerprint} / ${active.vectorDimension} 维`
          : '当前全文知识库'
        return {
          success: false,
          chunkCount: 0,
          error: `reindex_required: 嵌入空间与${current}不兼容；请先执行显式向量回填/重建，旧代际未被修改`,
        }
      }
      const vectorRecords = canonicalRecords.map((record, index) => ({
        ...record,
        vector: validation.vectors![index],
      }))
      embeddingWrite = await appendEmbeddingRecords(
        projectPath,
        db,
        registry,
        vectorRecords,
        validation.dimension,
        identity,
      )
    }

    const docInfo: DocumentInfo = {
      id: docId,
      fileName,
      importedAt: now,
      chunkCount: chunks.length,
      filePath: filePath || '',
      corpusKind,
    }
    if (!validation.vectors && registry.activeGeneration !== null) {
      // This must precede document/canonical writes. Do not restore the old
      // active pointer on a later write failure: it may no longer cover a
      // committed canonical row, whereas FTS remains authoritative and safe.
      writeRegistry(projectPath, registryWithNoActiveGeneration(registry))
    }
    rollbackRequired = true
    await writeDocumentInfo(db, tableNames, docInfo)

    await appendCanonicalRecords(db, await db.tableNames(), canonicalRecords)
    const canonicalTable = await db.openTable(TABLE_NAME)
    await ensureTextIndex(canonicalTable)

    if (embeddingWrite) {
      await finaliseEmbeddingWrite(projectPath, db, registry, embeddingWrite)
    }

    if (metadata?.replacementMode !== 'stable-id') {
      await pruneSupersededDocumentInfo(db, docInfo)
    }

    rollbackRequired = false
    return { success: true, chunkCount: chunks.length }
  } catch (error) {
    if (rollbackRequired && db) {
      await rollbackCurrentWrite(db, chunkIds, docId)
    }
    if (db && embeddingWrite) {
      await compensateEmbeddingWrite(db, embeddingWrite, chunkIds)
    }
    console.error('[Vela VectorStore] 写入失败:', error)
    return { success: false, chunkCount: 0, error: String(error) }
  }
}

/** 删除文档及其在所有嵌入空间中的块，不删除任何表。 */
export async function removeDocument(projectPath: string, docId: string): Promise<boolean> {
  try {
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    const registry = await loadOrRegisterLegacyRegistry(projectPath, db, tableNames)
    const escapedId = docId.replace(/'/g, "''")
    const targets = new Set<string>([
      TABLE_NAME,
      ...tableNames.filter(tableName => tableName.startsWith(EMBEDDING_TABLE_PREFIX)),
      ...registry.spaces.map(space => space.tableName),
    ])
    for (const tableName of targets) {
      if (tableNames.includes(tableName)) await (await db.openTable(tableName)).delete(`\`docId\` = '${escapedId}'`)
    }
    if (tableNames.includes(DOCS_TABLE_NAME)) {
      await (await db.openTable(DOCS_TABLE_NAME)).delete(`id = '${escapedId}'`)
    }

    // LanceDB cannot atomically delete across physical generations.  A retry is
    // safe only after proving that every registered and orphan generation has
    // reached the same zero-row postcondition.
    const remainingTableNames = await db.tableNames()
    const remainingTargets = new Set<string>([
      TABLE_NAME,
      ...remainingTableNames.filter(tableName => tableName.startsWith(EMBEDDING_TABLE_PREFIX)),
      ...registry.spaces.map(space => space.tableName),
    ])
    for (const tableName of remainingTargets) {
      if (!remainingTableNames.includes(tableName)) continue
      const rows = await (await db.openTable(tableName)).query()
        .filter(`\`docId\` = '${escapedId}'`)
        .limit(1)
        .toArray()
      if (rows.length > 0) return false
    }
    if (remainingTableNames.includes(DOCS_TABLE_NAME)) {
      const rows = await (await db.openTable(DOCS_TABLE_NAME)).query()
        .filter(`id = '${escapedId}'`)
        .limit(1)
        .toArray()
      if (rows.length > 0) return false
    }
    return true
  } catch (error) {
    console.error('[Vela VectorStore] 删除失败:', error)
    return false
  }
}

/**
 * 清空整个项目知识库。该函数是用户明确触发的清空操作，因而会删除所有代际。
 */
export async function clearAll(projectPath: string): Promise<boolean> {
  try {
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    for (const tableName of tableNames) {
      if (tableName === TABLE_NAME || tableName === DOCS_TABLE_NAME || tableName.startsWith(EMBEDDING_TABLE_PREFIX)) {
        await db.dropTable(tableName)
      }
    }
    const filePath = registryPath(projectPath)
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true })
    return true
  } catch (error) {
    console.error('[Vela VectorStore] 清空知识库失败:', error)
    return false
  }
}

export async function listDocuments(projectPath: string): Promise<DocumentInfo[]> {
  try {
    const db = await getConnection(projectPath)
    if (!(await db.tableNames()).includes(DOCS_TABLE_NAME)) return []
    const table = await db.openTable(DOCS_TABLE_NAME)
    await ensureCorpusKindColumn(table)
    const rows = await table.query().toArray()
    return rows.map((row: { id: string; fileName: string; importedAt: string; chunkCount: number; filePath?: string; corpusKind?: KnowledgeCorpusKind }) => ({
      id: row.id,
      fileName: row.fileName,
      importedAt: row.importedAt,
      chunkCount: row.chunkCount,
      filePath: row.filePath || '',
      corpusKind: row.corpusKind ?? 'unknown',
    }))
  } catch (error) {
    logFailure('VectorStore', 'listDocuments failed', error, { projectPath })
    return []
  }
}

export interface DocumentIntegrity {
  docId: string
  corpusKind: KnowledgeCorpusKind
  chunkCount: number
  chunkSetHash: string
  complete: boolean
  embeddingGenerations: Array<{
    generation: number | null
    tableName: string
    status: EmbeddingSpaceStatus | 'unregistered'
    chunkCount: number
    complete: boolean
  }>
}

export function hashCanonicalChunkSet(chunks: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(chunks), 'utf8').digest('hex')
}

/** Validate both the document commit row and every canonical chunk for a stable import. */
export async function getDocumentIntegrity(
  projectPath: string,
  docId: string,
): Promise<DocumentIntegrity | null> {
  const db = await getConnection(projectPath)
  const tableNames = await db.tableNames()
  const escapedId = docId.replace(/'/g, "''")
  let chunkRows: Array<{ id: string; chunkIndex: number; totalChunks: number; text: string; corpusKind?: KnowledgeCorpusKind }> = []
  if (tableNames.includes(TABLE_NAME)) {
    const chunksTable = await db.openTable(TABLE_NAME)
    await ensureCorpusKindColumn(chunksTable)
    chunkRows = await chunksTable.query()
      .filter(`\`docId\` = '${escapedId}'`)
      .select(['id', 'chunkIndex', 'totalChunks', 'text', 'corpusKind'])
      .toArray() as typeof chunkRows
  }
  let documentRows: Array<{ id: string; chunkCount: number; corpusKind?: KnowledgeCorpusKind }> = []
  if (tableNames.includes(DOCS_TABLE_NAME)) {
    const docsTable = await db.openTable(DOCS_TABLE_NAME)
    await ensureCorpusKindColumn(docsTable)
    documentRows = await docsTable.query()
      .filter(`id = '${escapedId}'`)
      .select(['id', 'chunkCount', 'corpusKind'])
      .toArray() as typeof documentRows
  }
  const ordered = [...chunkRows].sort((left, right) => left.chunkIndex - right.chunkIndex)
  const document = documentRows[0]
  const corpusKind = document?.corpusKind ?? ordered[0]?.corpusKind ?? 'unknown'
  const canonicalComplete = documentRows.length === 1
    && ordered.length > 0
    && document?.chunkCount === ordered.length
    && new Set(ordered.map(row => row.id)).size === ordered.length
    && ordered.every((row, index) => (
      row.chunkIndex === index
      && row.totalChunks === ordered.length
      && (row.corpusKind ?? 'unknown') === corpusKind
      && typeof row.text === 'string'
    ))

  const registry = readRegistry(projectPath) ?? await inferLegacyRegistry(db, tableNames)
  const registeredByTable = new Map(registry.spaces.map(space => [space.tableName, space] as const))
  const physicalEmbeddingTables = new Set(
    tableNames.filter(tableName => tableName.startsWith(EMBEDDING_TABLE_PREFIX)),
  )
  for (const space of registry.spaces) {
    physicalEmbeddingTables.add(space.tableName)
  }
  const canonicalByIndex = new Map(ordered.map(row => [row.chunkIndex, row] as const))
  const embeddingGenerations: DocumentIntegrity['embeddingGenerations'] = []
  for (const tableName of [...physicalEmbeddingTables].sort()) {
    let rows: Array<{
      id?: unknown
      chunkIndex?: unknown
      totalChunks?: unknown
      text?: unknown
      vector?: unknown
      corpusKind?: KnowledgeCorpusKind
    }> = []
    if (tableNames.includes(tableName)) {
      const table = await db.openTable(tableName)
      await ensureCorpusKindColumn(table)
      rows = await table.query()
        .filter(`\`docId\` = '${escapedId}'`)
        .toArray() as typeof rows
    }
    const registered = registeredByTable.get(tableName)
    const required = rows.length > 0 || registered?.generation === registry.activeGeneration
    const orderedEmbeddingRows = [...rows].sort((left, right) => (
      typeof left.chunkIndex === 'number' && typeof right.chunkIndex === 'number'
        ? left.chunkIndex - right.chunkIndex
        : 0
    ))
    const indexes = orderedEmbeddingRows.map(row => row.chunkIndex)
    const exactSequence = canonicalComplete
      && !!registered
      && orderedEmbeddingRows.length === ordered.length
      && new Set(indexes).size === orderedEmbeddingRows.length
      && orderedEmbeddingRows.every((row, index) => {
        const canonical = canonicalByIndex.get(index)
        return row.chunkIndex === index
          && row.totalChunks === ordered.length
          && row.id === canonical?.id
          && row.text === canonical?.text
          && (row.corpusKind ?? 'unknown') === corpusKind
          && vectorIsUsable(row.vector, registered.vectorDimension)
      })
    embeddingGenerations.push({
      generation: registered?.generation ?? null,
      tableName,
      status: registered?.status ?? 'unregistered',
      chunkCount: rows.length,
      complete: !required || (!!registered && exactSequence),
    })
  }
  if (
    documentRows.length === 0
    && chunkRows.length === 0
    && embeddingGenerations.every(generation => generation.chunkCount === 0)
  ) return null
  return {
    docId,
    corpusKind,
    chunkCount: ordered.length,
    chunkSetHash: hashCanonicalChunkSet(ordered.map(row => row.text)),
    // A building generation is intentionally allowed to contain a bounded
    // prefix while backfill is running.  Active/inactive registry entries are
    // durable completion markers; unregistered rows are crash residue.
    complete: canonicalComplete && embeddingGenerations.every(generation => (
      generation.status === 'building' || generation.complete
    )),
    embeddingGenerations,
  }
}

export async function getStats(projectPath: string): Promise<KBStats> {
  try {
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    if (!tableNames.includes(TABLE_NAME)) {
      return { documentCount: 0, totalChunks: 0, vectorDimension: 0, hasVectors: false }
    }
    const docs = tableNames.includes(DOCS_TABLE_NAME)
      ? await (await db.openTable(DOCS_TABLE_NAME)).countRows()
      : 0
    const registry = await loadOrRegisterLegacyRegistry(projectPath, db, tableNames)
    const active = activeSpace(registry)
    return {
      documentCount: docs,
      totalChunks: await (await db.openTable(TABLE_NAME)).countRows(),
      vectorDimension: active?.vectorDimension ?? 0,
      hasVectors: active !== undefined,
    }
  } catch {
    return { documentCount: 0, totalChunks: 0, vectorDimension: 0, hasVectors: false }
  }
}

function backfillSpaceForIdentity(registry: EmbeddingSpaceRegistry, identity?: EmbeddingSpaceIdentity): EmbeddingSpace | undefined {
  if (!identity) return activeSpace(registry) ?? registry.spaces.find(space => space.status === 'building')
  const requested = normalizedIdentity(identity)
  return registry.spaces.find(space => (
    space.modelFingerprint === requested.modelFingerprint
    && space.distanceMetric === requested.distanceMetric
    && (space.status === 'active' || space.status === 'building')
  ))
}

async function vectorisedIdsForSpace(db: lancedb.Connection, space: EmbeddingSpace | undefined): Promise<Set<string>> {
  if (!space) return new Set()
  const rows = await (await db.openTable(space.tableName)).query().select(['id', 'vector']).toArray()
  return new Set(
    rows
      .filter(row => vectorIsUsable((row as { vector?: unknown }).vector, space.vectorDimension))
      .map(row => (row as { id: string }).id),
  )
}

async function missingCanonicalRows(
  db: lancedb.Connection,
  space: EmbeddingSpace | undefined,
): Promise<Array<{ id: string; text: string }>> {
  const rows = await (await db.openTable(TABLE_NAME)).query().select(['id', 'text']).toArray()
  const vectorisedIds = await vectorisedIdsForSpace(db, space)
  return rows
    .map(row => ({ id: (row as { id: string }).id, text: (row as { text: string }).text }))
    .filter(row => !vectorisedIds.has(row.id))
}

export async function getChunksWithoutVectors(
  projectPath: string,
  embeddingSpace?: EmbeddingSpaceIdentity,
): Promise<{ count: number }> {
  const db = await getConnection(projectPath)
  const tableNames = await db.tableNames()
  if (!tableNames.includes(TABLE_NAME)) return { count: 0 }
  const registry = await loadOrRegisterLegacyRegistry(projectPath, db, tableNames)
  return { count: (await missingCanonicalRows(db, backfillSpaceForIdentity(registry, embeddingSpace))).length }
}

/** 返回当前模型需要回填的文本块；不在此处创建或删除表。 */
export async function getChunksForBackfill(
  projectPath: string,
  batchSize: number = 50,
  embeddingSpace?: EmbeddingSpaceIdentity,
): Promise<Array<{ id: string; text: string }>> {
  const db = await getConnection(projectPath)
  const tableNames = await db.tableNames()
  if (!tableNames.includes(TABLE_NAME)) return []
  // Migration preflight must not create an embedding registry. If validation
  // rejects this legacy source, the project needs to remain byte-for-byte as
  // it was before the attempt.
  const registry = readRegistry(projectPath) ?? await inferLegacyRegistry(db, tableNames)
  return (await missingCanonicalRows(db, backfillSpaceForIdentity(registry, embeddingSpace))).slice(0, batchSize)
}

/**
 * 为已存在的 canonical 文本块添加向量。实际维度由更新批次决定；不覆写或
 * drop 旧表，且只有完整覆盖 canonical 表后才可能切换 active。
 */
export async function updateChunkVectors(
  projectPath: string,
  updates: Array<{ id: string; vector: number[] }>,
  embeddingSpace?: EmbeddingSpaceIdentity,
): Promise<{ success: boolean; count: number; error?: string }> {
  const validation = validateVectorsForChunks(updates.map(update => update.id), updates.map(update => update.vector))
  if (validation.error || !validation.vectors || validation.dimension === undefined) {
    return { success: false, count: 0, error: validation.error ?? '向量批次为空，无法回填' }
  }
  if (new Set(updates.map(update => update.id)).size !== updates.length) {
    return { success: false, count: 0, error: '回填向量包含重复块标识' }
  }

  let db: lancedb.Connection | undefined
  let write: EmbeddingWrite | undefined
  try {
    db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    if (!tableNames.includes(TABLE_NAME)) return { success: false, count: 0, error: 'chunks 表不存在' }
    const canonicalRows = await (await db.openTable(TABLE_NAME)).query().toArray()
    const updateById = new Map(updates.map(update => [update.id, update.vector]))
    const records = canonicalRows
      .filter(row => updateById.has((row as { id: string }).id))
      .map((row) => ({
        ...(row as Record<string, unknown>),
        vector: updateById.get((row as { id: string }).id)!,
      })) as ChunkRecord[]
    if (records.length !== updates.length) {
      return { success: false, count: 0, error: '回填目标块不存在，未修改任何嵌入空间' }
    }

    const registry = await loadOrRegisterLegacyRegistry(projectPath, db, tableNames)
    write = await appendEmbeddingRecords(
      projectPath,
      db,
      registry,
      records,
      validation.dimension,
      normalizedIdentity(embeddingSpace, validation.dimension),
    )
    await finaliseEmbeddingWrite(projectPath, db, registry, write)
    return { success: true, count: updates.length }
  } catch (error) {
    if (db && write) {
      await compensateEmbeddingWrite(db, write, updates.map(update => update.id))
    }
    console.error('[Vela VectorStore] 批量更新向量失败:', error)
    return { success: false, count: 0, error: String(error) }
  }
}
