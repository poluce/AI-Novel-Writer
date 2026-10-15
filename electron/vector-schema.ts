/**
 * Arrow schemas and vector validation for LanceDB chunk records.
 */
import type * as lancedb from '@lancedb/lancedb'
import { Field, FixedSizeList as ArrowFixedSizeList, Float32, Int32, Utf8, Schema as ArrowSchema } from 'apache-arrow'

/** 写入 LanceDB 的文本块记录 */
export interface ChunkRecord {
  [key: string]: unknown
  id: string
  docId: string
  fileName: string
  /** 章节号（可选，用于范围检索） */
  chapterNumber?: number
  /** 章节标题（可选，用于展示） */
  chapterTitle?: string
  text: string
  vector?: number[]
  chunkIndex: number
  totalChunks: number
  importedAt: string
  corpusKind: KnowledgeCorpusKind
}

export type KnowledgeCorpusKind = 'reference' | 'project-knowledge' | 'unknown'

export function canonicalChunkSchema(): ArrowSchema {
  return new ArrowSchema([
    new Field('id', new Utf8()),
    new Field('docId', new Utf8()),
    new Field('fileName', new Utf8()),
    new Field('chapterNumber', new Int32(), true),
    new Field('chapterTitle', new Utf8(), true),
    new Field('text', new Utf8()),
    new Field('chunkIndex', new Int32()),
    new Field('totalChunks', new Int32()),
    new Field('importedAt', new Utf8()),
    new Field('corpusKind', new Utf8()),
  ])
}

export function embeddingChunkSchema(dimension: number): ArrowSchema {
  return new ArrowSchema([
    new Field('id', new Utf8()),
    new Field('docId', new Utf8()),
    new Field('fileName', new Utf8()),
    new Field('chapterNumber', new Int32(), true),
    new Field('chapterTitle', new Utf8(), true),
    new Field('text', new Utf8()),
    new Field('vector', new ArrowFixedSizeList(dimension, new Field('item', new Float32())), false),
    new Field('chunkIndex', new Int32()),
    new Field('totalChunks', new Int32()),
    new Field('importedAt', new Utf8()),
    new Field('corpusKind', new Utf8()),
  ])
}

export function validateVectorsForChunks(chunks: readonly unknown[], vectors?: unknown): { vectors?: number[][]; dimension?: number; error?: string } {
  if (vectors === undefined) return {}
  if (!Array.isArray(vectors)) {
    return { error: '向量批次无效：必须是与文本块一一对应的数组' }
  }
  if (vectors.length !== chunks.length) {
    return { error: `向量批次数量不匹配：期望 ${chunks.length}，实际 ${vectors.length}` }
  }
  if (vectors.length === 0) {
    return { error: '向量批次为空，无法建立嵌入空间' }
  }

  let dimension: number | undefined
  const normalized: number[][] = []
  for (let index = 0; index < vectors.length; index += 1) {
    const vector = vectors[index]
    if (!Array.isArray(vector) || vector.length === 0) {
      return { error: `第 ${index + 1} 个向量为空或无效` }
    }
    if (dimension === undefined) {
      dimension = vector.length
    } else if (vector.length !== dimension) {
      return { error: `向量维度不一致：第 1 个为 ${dimension} 维，第 ${index + 1} 个为 ${vector.length} 维` }
    }
    const values: number[] = []
    for (const value of vector) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { error: `第 ${index + 1} 个向量包含非有限数值` }
      }
      values.push(value)
    }
    normalized.push(values)
  }

  return { vectors: normalized, dimension }
}

export function validateChunks(chunks: unknown): chunks is string[] {
  return Array.isArray(chunks) && chunks.length > 0 && chunks.every(chunk => typeof chunk === 'string')
}

export function asNumberArray(value: unknown): number[] | undefined {
  if (Array.isArray(value)) return value.filter((entry): entry is number => typeof entry === 'number')
  if (value && typeof value === 'object' && 'toArray' in value && typeof value.toArray === 'function') {
    return asNumberArray(value.toArray())
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return Array.from(value as unknown as ArrayLike<number>)
  }
  return undefined
}

export function vectorIsUsable(value: unknown, dimension?: number): boolean {
  const vector = asNumberArray(value)
  return vector !== undefined
    && vector.length > 0
    && (dimension === undefined || vector.length === dimension)
    && vector.every(Number.isFinite)
}

export function dimensionFromField(field: { type?: unknown } | undefined): number | undefined {
  if (!field?.type || typeof field.type !== 'object') return undefined
  const listSize = (field.type as { listSize?: unknown }).listSize
  return typeof listSize === 'number' && Number.isInteger(listSize) && listSize > 0 ? listSize : undefined
}

export async function vectorDimensionFromTable(table: lancedb.Table): Promise<number | undefined> {
  const schema = await table.schema()
  const vectorField = schema.fields.find(field => field.name === 'vector')
  const fieldDimension = dimensionFromField(vectorField)
  if (fieldDimension !== undefined) return fieldDimension

  if (!vectorField) return undefined
  const rows = await table.query().select(['vector']).limit(1).toArray()
  const vector = rows[0] && asNumberArray((rows[0] as { vector?: unknown }).vector)
  return vector?.length || undefined
}

export function recordsForSchema(records: ReadonlyArray<Record<string, unknown>>, schema: { fields: Array<{ name: string }> }): Record<string, unknown>[] {
  const fieldNames = new Set(schema.fields.map(field => field.name))
  return records.map((record) => {
    const compatible: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(record)) {
      if (value !== undefined && fieldNames.has(key)) compatible[key] = value
    }
    return compatible
  })
}
