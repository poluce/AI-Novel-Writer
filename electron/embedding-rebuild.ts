/**
 * Isolated embedding-generation planning and rebuild.
 * Shared table-creation helpers live in vector-documents so documents never import this file.
 */
import type * as lancedb from '@lancedb/lancedb'
import {
  TABLE_NAME,
  getConnection,
} from './vector-connection'
import {
  embeddingChunkSchema,
  validateVectorsForChunks,
  type ChunkRecord,
} from './vector-schema'
import {
  inferLegacyRegistry,
  matchingSpace,
  nextSpace,
  normalizedIdentity,
  readRegistry,
  registryWithActiveGeneration,
  writeRegistry,
  type EmbeddingSpace,
  type EmbeddingSpaceIdentity,
} from './embedding-registry'
import {
  completeForCanonicalTable,
  createOwnedEmbeddingTable,
  verifyQueryableEmbeddingSpace,
} from './vector-documents'

/**
 * A rebuild is deliberately planned only after a real embedding response has
 * supplied its dimension.  `rebuild` always receives every canonical chunk
 * and writes an isolated generation; it never appends to the current active
 * table.
 */
export type EmbeddingRebuildMode = 'up-to-date' | 'activate' | 'rebuild'

export interface EmbeddingRebuildPlan {
  mode: EmbeddingRebuildMode
  identity: Required<EmbeddingSpaceIdentity>
  vectorDimension: number
  chunks: Array<{ id: string; text: string }>
}

export type EmbeddingRebuildPlanResult =
  | { success: true; plan: EmbeddingRebuildPlan }
  | { success: false; error: string }

async function canonicalRecordsForEmbeddingRebuild(
  db: lancedb.Connection,
): Promise<ChunkRecord[]> {
  const rows = await (await db.openTable(TABLE_NAME)).query().toArray()
  return rows.map(row => ({ ...(row as Record<string, unknown>) })) as ChunkRecord[]
}

function canonicalReferences(records: readonly ChunkRecord[]): Array<{ id: string; text: string }> {
  return records.map(record => ({ id: record.id, text: record.text }))
}

/**
 * Return canonical text without selecting an embedding generation.  The
 * knowledge-base layer uses one of these rows as an actual-provider probe
 * before deciding which generation may receive a write.
 */
export async function getCanonicalChunksForEmbeddingRebuild(
  projectPath: string,
): Promise<Array<{ id: string; text: string }>> {
  // Validate persisted metadata before the caller makes any provider request.
  // This is intentionally read-only and does not infer/register legacy state.
  readRegistry(projectPath)
  const db = await getConnection(projectPath)
  if (!(await db.tableNames()).includes(TABLE_NAME)) return []
  return canonicalReferences(await canonicalRecordsForEmbeddingRebuild(db))
}

/**
 * Plan an explicit rebuild only after a real response established the actual
 * vector dimension.  This is read-only: invalid probes and failed planning
 * leave the existing registry and every vector table untouched.
 */
export async function planEmbeddingRebuild(
  projectPath: string,
  embeddingSpace: EmbeddingSpaceIdentity | undefined,
  probeVector: unknown,
): Promise<EmbeddingRebuildPlanResult> {
  const validation = validateVectorsForChunks(['canonical probe'], [probeVector])
  if (validation.error || validation.dimension === undefined) {
    return { success: false, error: validation.error ?? '嵌入探测响应为空，无法确定向量维度' }
  }

  const identity = normalizedIdentity(embeddingSpace, validation.dimension)
  try {
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    if (!tableNames.includes(TABLE_NAME)) {
      return {
        success: true,
        plan: { mode: 'up-to-date', identity, vectorDimension: validation.dimension, chunks: [] },
      }
    }

    // Unlike ordinary reads, a failed probe/planning pass must not create a
    // registry for a legacy table.  A registry is persisted only with a
    // verified, successful switch below.
    const registry = readRegistry(projectPath) ?? await inferLegacyRegistry(db, tableNames)
    const canonical = await canonicalRecordsForEmbeddingRebuild(db)
    const matching = matchingSpace(registry, identity, validation.dimension)
    if (matching && tableNames.includes(matching.tableName)) {
      const complete = await completeForCanonicalTable(db, matching)
      const queryable = complete && await verifyQueryableEmbeddingSpace(db, matching)
      if (queryable) {
        return {
          success: true,
          plan: {
            mode: registry.activeGeneration === matching.generation ? 'up-to-date' : 'activate',
            identity,
            vectorDimension: validation.dimension,
            chunks: [],
          },
        }
      }
    }

    // An incomplete or dimension-incompatible generation is never amended in
    // place by this flow.  A separate table lets the prior active generation
    // continue serving queries until every canonical row is verified.
    return {
      success: true,
      plan: {
        mode: 'rebuild',
        identity,
        vectorDimension: validation.dimension,
        chunks: canonicalReferences(canonical),
      },
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Atomically select a previously complete generation.  It re-verifies the
 * table before changing the registry, so a failed activation cannot demote an
 * old active generation.
 */
export async function activatePlannedEmbeddingSpace(
  projectPath: string,
  plan: EmbeddingRebuildPlan,
): Promise<{ success: boolean; error?: string }> {
  if (plan.mode !== 'activate') {
    return { success: false, error: '当前嵌入空间不允许直接激活' }
  }
  try {
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    const registry = readRegistry(projectPath) ?? await inferLegacyRegistry(db, tableNames)
    const matching = matchingSpace(registry, plan.identity, plan.vectorDimension)
    if (!matching || !tableNames.includes(matching.tableName)) {
      return { success: false, error: '目标嵌入空间不存在，未修改当前索引' }
    }
    if (!(await completeForCanonicalTable(db, matching)) || !(await verifyQueryableEmbeddingSpace(db, matching))) {
      return { success: false, error: '目标嵌入空间未完整验证，旧索引保持不变' }
    }
    writeRegistry(projectPath, registryWithActiveGeneration(registry, matching.generation))
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Build a fresh generation from a full, frozen canonical snapshot.  Every
 * validation happens before creating the new table; after creation the table
 * is removed on every unsuccessful path.  The prior registry is only written
 * after the new generation has passed completeness and query probes.
 */
export async function rebuildPlannedEmbeddingSpace(
  projectPath: string,
  plan: EmbeddingRebuildPlan,
  updates: Array<{ id: string; vector: number[] }>,
): Promise<{ success: boolean; count: number; error?: string }> {
  if (plan.mode !== 'rebuild') {
    return { success: false, count: 0, error: '当前嵌入空间不需要新建代际' }
  }
  if (updates.length !== plan.chunks.length || new Set(updates.map(update => update.id)).size !== updates.length) {
    return { success: false, count: 0, error: '重建向量与冻结文本块不一致，未修改当前索引' }
  }
  const validation = validateVectorsForChunks(plan.chunks.map(chunk => chunk.id), updates.map(update => update.vector))
  if (validation.error || !validation.vectors || validation.dimension === undefined) {
    return { success: false, count: 0, error: validation.error ?? '重建向量无效' }
  }
  if (validation.dimension !== plan.vectorDimension) {
    return { success: false, count: 0, error: '重建期间向量维度发生变化，旧索引保持不变' }
  }

  let db: lancedb.Connection | undefined
  let newSpace: EmbeddingSpace | undefined
  let tableCreated = false
  try {
    db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    if (!tableNames.includes(TABLE_NAME)) {
      return { success: false, count: 0, error: '知识库文本块不存在，未修改当前索引' }
    }
    const registry = readRegistry(projectPath) ?? await inferLegacyRegistry(db, tableNames)
    const canonical = await canonicalRecordsForEmbeddingRebuild(db)
    const plannedById = new Map(plan.chunks.map(chunk => [chunk.id, chunk.text]))
    if (
      canonical.length !== plan.chunks.length
      || plannedById.size !== plan.chunks.length
      || canonical.some(record => plannedById.get(record.id) !== record.text)
    ) {
      return { success: false, count: 0, error: '知识库文本已变化，请重新检查并重建向量索引' }
    }
    // A concurrent completed rebuild should be observed and replanned rather
    // than appended to. An incomplete generation is intentionally left alone;
    // this operation creates another isolated table instead of mutating it.
    const existing = matchingSpace(registry, plan.identity, plan.vectorDimension)
    if (
      existing
      && tableNames.includes(existing.tableName)
      && await completeForCanonicalTable(db, existing)
      && await verifyQueryableEmbeddingSpace(db, existing)
    ) {
      return { success: false, count: 0, error: '嵌入空间状态已变化，请重新检查并重建向量索引' }
    }

    const vectorsById = new Map(updates.map((update, index) => [update.id, validation.vectors![index]]))
    if (vectorsById.size !== canonical.length || canonical.some(record => !vectorsById.has(record.id))) {
      return { success: false, count: 0, error: '重建向量缺少文本块，旧索引保持不变' }
    }
    newSpace = nextSpace(registry, plan.identity, plan.vectorDimension)
    const records = canonical.map(record => ({ ...record, vector: vectorsById.get(record.id)! }))
    await createOwnedEmbeddingTable(
      projectPath,
      db,
      newSpace,
      records,
      embeddingChunkSchema(plan.vectorDimension),
    )
    tableCreated = true

    if (!(await completeForCanonicalTable(db, newSpace)) || !(await verifyQueryableEmbeddingSpace(db, newSpace))) {
      throw new Error('新嵌入空间未通过完整性验证')
    }
    const nextRegistry = registryWithActiveGeneration({
      version: 1,
      activeGeneration: registry.activeGeneration,
      spaces: [...registry.spaces.map(space => ({ ...space })), newSpace],
    }, newSpace.generation)
    writeRegistry(projectPath, nextRegistry)
    return { success: true, count: records.length }
  } catch (error) {
    if (tableCreated && db && newSpace) {
      try {
        await db.dropTable(newSpace.tableName)
      } catch (cleanupError) {
        console.warn('[Vela VectorStore] 清理失败的嵌入重建表失败:', cleanupError)
      }
    }
    return {
      success: false,
      count: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
