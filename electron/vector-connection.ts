/**
 * LanceDB connection cache and on-disk paths shared by the vector store.
 */
import * as lancedb from '@lancedb/lancedb'
import fs from 'node:fs'
import path from 'node:path'

// ===== 常量 =====

export const TABLE_NAME = 'chunks'
export const DOCS_TABLE_NAME = 'documents'
export const EMBEDDING_TABLE_PREFIX = 'chunks__space_'
const EMBEDDING_REGISTRY_FILE = 'embedding-spaces.json'
const LEGACY_MIGRATION_JOURNAL_FILE = 'vectors.json.migration-journal.json'
export const LEGACY_MODEL_FINGERPRINT = 'legacy:unknown'
export const LEGACY_COMPAT_MODEL_PREFIX = 'legacy:dimension:'
export const DEFAULT_DISTANCE_METRIC = 'l2'

// ===== 连接池（按项目路径缓存） =====

const connectionPool = new Map<string, lancedb.Connection>()

export function databasePath(projectPath: string): string {
  return path.join(projectPath, '.vela', 'lancedb')
}

export function registryPath(projectPath: string): string {
  return path.join(projectPath, '.vela', EMBEDDING_REGISTRY_FILE)
}

export function legacyMigrationJournalPath(projectPath: string): string {
  return path.join(projectPath, '.vela', LEGACY_MIGRATION_JOURNAL_FILE)
}

export function embeddingTableDirectory(projectPath: string, tableName: string): string {
  return path.join(databasePath(projectPath), `${tableName}.lance`)
}

/** 获取 LanceDB 连接（惰性创建） */
export async function getConnection(projectPath: string): Promise<lancedb.Connection> {
  const dbPath = databasePath(projectPath)
  const cached = connectionPool.get(dbPath)
  if (cached) return cached

  fs.mkdirSync(dbPath, { recursive: true })
  const db = await lancedb.connect(dbPath)
  connectionPool.set(dbPath, db)
  return db
}

/** 关闭指定项目的连接 */
export function closeConnection(projectPath: string): void {
  const dbPath = databasePath(projectPath)
  const connection = connectionPool.get(dbPath)
  connectionPool.delete(dbPath)
  connection?.close()
}
