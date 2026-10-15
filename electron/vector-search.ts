/**
 * Active-space vector search with FTS fallback. Does not import document writes.
 */
import type * as lancedb from '@lancedb/lancedb'
import {
  TABLE_NAME,
  getConnection,
} from './vector-connection'
import {
  vectorIsUsable,
  type KnowledgeCorpusKind,
} from './vector-schema'
import {
  activeSpace,
  loadOrRegisterLegacyRegistry,
  normalizedIdentity,
  type EmbeddingSpace,
  type EmbeddingSpaceIdentity,
} from './embedding-registry'

/** 检索结果 */
export interface SearchResult {
  text: string
  score: number
  fileName: string
}

function requestMatchesActiveSpace(
  space: EmbeddingSpace,
  queryVector: number[],
  identity?: EmbeddingSpaceIdentity,
): boolean {
  if (!vectorIsUsable(queryVector, space.vectorDimension)) return false
  if (!identity) return true // 保持既有 vector-store 直接调用的兼容性。
  const requested = normalizedIdentity(identity, queryVector.length)
  return space.modelFingerprint === requested.modelFingerprint && space.distanceMetric === requested.distanceMetric
}

async function tableSupportsField(table: lancedb.Table, fieldName: string): Promise<boolean> {
  return (await table.schema()).fields.some(field => field.name === fieldName)
}

function excludedCorpusFilter(excludedCorpusKinds: readonly KnowledgeCorpusKind[]): string | undefined {
  const values = [...new Set(excludedCorpusKinds)]
  if (values.length === 0) return undefined
  return `\`corpusKind\` NOT IN (${values.map(value => `'${value}'`).join(', ')})`
}

/** 统一检索入口 — 仅对当前 active 且身份匹配的空间使用向量，其他情况安全降级 FTS。 */
export async function search(
  projectPath: string,
  queryText: string,
  queryVector?: number[],
  topK: number = 5,
  embeddingSpace?: EmbeddingSpaceIdentity,
  excludedCorpusKinds: readonly KnowledgeCorpusKind[] = [],
): Promise<SearchResult[]> {
  return searchWithScope(
    projectPath,
    queryText,
    queryVector,
    topK,
    undefined,
    embeddingSpace,
    excludedCorpusKinds,
  )
}

/** 支持章节范围限定的检索入口。 */
export async function searchWithScope(
  projectPath: string,
  queryText: string,
  queryVector?: number[],
  topK: number = 5,
  chapterScope?: [number, number],
  embeddingSpace?: EmbeddingSpaceIdentity,
  excludedCorpusKinds: readonly KnowledgeCorpusKind[] = [],
): Promise<SearchResult[]> {
  try {
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    if (!tableNames.includes(TABLE_NAME)) return []

    let scopeFilter: string | undefined
    if (chapterScope) {
      const [from, to] = chapterScope
      scopeFilter = `\`chapterNumber\` >= ${from} AND \`chapterNumber\` <= ${to}`
    }

    if (queryVector && vectorIsUsable(queryVector)) {
      try {
        const registry = await loadOrRegisterLegacyRegistry(projectPath, db, tableNames)
        const active = activeSpace(registry)
        if (active && tableNames.includes(active.tableName) && requestMatchesActiveSpace(active, queryVector, embeddingSpace)) {
          const vectorTable = await db.openTable(active.tableName)
          let query = vectorTable.search(queryVector).limit(topK)
          const vectorFilters: string[] = []
          if (scopeFilter && await tableSupportsField(vectorTable, 'chapterNumber')) {
            vectorFilters.push(scopeFilter)
          }
          const corpusFilter = excludedCorpusFilter(excludedCorpusKinds)
          if (corpusFilter && await tableSupportsField(vectorTable, 'corpusKind')) {
            vectorFilters.push(corpusFilter)
          }
          if (vectorFilters.length > 0) query = query.where(vectorFilters.join(' AND '))
          const results = await query.toArray()
          if (results.length > 0) {
            return results.map((row: { text: string; _distance?: number; fileName: string }) => ({
              text: row.text,
              score: row._distance != null ? 1 / (1 + row._distance) : 0.5,
              fileName: row.fileName,
            }))
          }
        }
      } catch (error) {
        console.warn('[Vela VectorStore] 向量检索降级为全文检索:', error)
      }
    }

    try {
      const canonicalTable = await db.openTable(TABLE_NAME)
      const rawTerms = queryText.match(/[\p{L}\p{N}-]+/gu) ?? []
      const meaningfulTerms = rawTerms.filter(term => Array.from(term).length >= 2)
      const searchTerms = [...new Map(
        (meaningfulTerms.length > 0 ? meaningfulTerms : rawTerms)
          .map(term => [term.toLocaleLowerCase(), term]),
      ).values()].slice(0, 8)
      const textFilter = searchTerms.length > 0
        ? `(${searchTerms
            .map(term => `text LIKE '%${term.replace(/'/g, "''")}%'`)
            .join(' OR ')})`
        : "text LIKE '%%'"
      const filters = [textFilter]
      if (scopeFilter && await tableSupportsField(canonicalTable, 'chapterNumber')) {
        filters.push(scopeFilter)
      }
      const corpusFilter = excludedCorpusFilter(excludedCorpusKinds)
      if (corpusFilter && await tableSupportsField(canonicalTable, 'corpusKind')) {
        filters.push(corpusFilter)
      }
      const filter = filters.join(' AND ')
      const results = await canonicalTable.query().filter(filter).toArray()
      const normalizedTerms = searchTerms.map(term => term.toLocaleLowerCase())
      const ftsResults = results
        .map((row: { text: string; fileName: string }) => ({
          result: { text: row.text, score: 0.5, fileName: row.fileName },
          relevance: normalizedTerms.reduce((score, term, index) => (
            row.text.toLocaleLowerCase().includes(term)
              ? score + normalizedTerms.length - index
              : score
          ), 0),
        }))
        .sort((left, right) => right.relevance - left.relevance)
        .map(candidate => candidate.result)
      const uniqueResults = new Map<string, SearchResult>()
      for (const result of ftsResults) {
        const key = JSON.stringify([result.fileName, result.text])
        if (!uniqueResults.has(key)) uniqueResults.set(key, result)
      }
      return [...uniqueResults.values()].slice(0, topK)
    } catch (error) {
      console.warn('[Vela VectorStore] 纯文本检索失败:', error)
      return []
    }
  } catch (error) {
    console.error('[Vela VectorStore] 检索失败:', error)
    return []
  }
}
