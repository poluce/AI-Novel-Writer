/**
 * Vela 向量数据库封装 — 基于 LanceDB
 *
 * `chunks` 是始终可用的全文文本事实源。每个嵌入空间都有独立物理表，避免
 * 不同模型、维度或距离语义的向量混写进同一 Arrow FixedSizeList。
 */

export { closeConnection, getConnection } from './vector-connection'

export type { ChunkRecord, KnowledgeCorpusKind } from './vector-schema'

export type {
  EmbeddingSpace,
  EmbeddingSpaceIdentity,
  EmbeddingSpaceRegistry,
  EmbeddingSpaceStatus,
} from './embedding-registry'
export { getEmbeddingSpaces } from './embedding-registry'

export type {
  EmbeddingRebuildMode,
  EmbeddingRebuildPlan,
  EmbeddingRebuildPlanResult,
} from './embedding-rebuild'
export {
  activatePlannedEmbeddingSpace,
  getCanonicalChunksForEmbeddingRebuild,
  planEmbeddingRebuild,
  rebuildPlannedEmbeddingSpace,
} from './embedding-rebuild'

export type { DocumentInfo, DocumentIntegrity, KBStats } from './vector-documents'
export {
  addChunks,
  clearAll,
  getChunksForBackfill,
  getChunksWithoutVectors,
  getDocumentIntegrity,
  getStats,
  hashCanonicalChunkSet,
  listDocuments,
  removeDocument,
  updateChunkVectors,
} from './vector-documents'

export type { SearchResult } from './vector-search'
export { search, searchWithScope } from './vector-search'

export { migrateFromJSON } from './vector-legacy-migration'
