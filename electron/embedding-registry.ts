/**
 * Embedding-space registry read/write, identity, and legacy registration.
 * Legacy registration may read a vector dimension; it does not read document text.
 */
import type * as lancedb from '@lancedb/lancedb'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_DISTANCE_METRIC,
  EMBEDDING_TABLE_PREFIX,
  LEGACY_COMPAT_MODEL_PREFIX,
  LEGACY_MODEL_FINGERPRINT,
  TABLE_NAME,
  getConnection,
  registryPath,
} from './vector-connection'
import { vectorDimensionFromTable } from './vector-schema'

/** 由调用方提供、且不包含密钥的嵌入模型身份。 */
export interface EmbeddingSpaceIdentity {
  modelFingerprint?: string
  distanceMetric?: string
}

export type EmbeddingSpaceStatus = 'active' | 'building' | 'inactive'

/** 一个可比较的向量集合及其物理表。 */
export interface EmbeddingSpace {
  generation: number
  tableName: string
  modelFingerprint: string
  vectorDimension: number
  distanceMetric: string
  status: EmbeddingSpaceStatus
  createdAt: string
}

export interface EmbeddingSpaceRegistry {
  version: 1
  activeGeneration: number | null
  spaces: EmbeddingSpace[]
}

export function normalizedIdentity(identity?: EmbeddingSpaceIdentity, dimension?: number): Required<EmbeddingSpaceIdentity> {
  return {
    // 旧的 vector-store 直调没有模型描述符；以维度作为保守兼容身份，避免把
    // 不同维度误判为同一模型，同时不破坏同维度旧调用的读写行为。
    modelFingerprint: identity?.modelFingerprint?.trim() || `${LEGACY_COMPAT_MODEL_PREFIX}${dimension ?? 'unknown'}`,
    distanceMetric: identity?.distanceMetric?.trim().toLowerCase() || DEFAULT_DISTANCE_METRIC,
  }
}

function emptyRegistry(): EmbeddingSpaceRegistry {
  return { version: 1, activeGeneration: null, spaces: [] }
}

function validateRegistry(value: unknown): EmbeddingSpaceRegistry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('嵌入空间元数据损坏，未修改现有向量表')
  }
  const candidate = value as Partial<EmbeddingSpaceRegistry>
  if (candidate.version !== 1 || !Array.isArray(candidate.spaces)) {
    throw new Error('嵌入空间元数据版本无效，未修改现有向量表')
  }
  const spaces = candidate.spaces.map((space) => {
    if (
      !space
      || typeof space.generation !== 'number'
      || !Number.isInteger(space.generation)
      || space.generation < 0
      || typeof space.tableName !== 'string'
      || !space.tableName
      || typeof space.modelFingerprint !== 'string'
      || !space.modelFingerprint
      || typeof space.vectorDimension !== 'number'
      || !Number.isInteger(space.vectorDimension)
      || space.vectorDimension <= 0
      || typeof space.distanceMetric !== 'string'
      || !space.distanceMetric
      || !['active', 'building', 'inactive'].includes(space.status)
      || typeof space.createdAt !== 'string'
    ) {
      throw new Error('嵌入空间元数据字段无效，未修改现有向量表')
    }
    return { ...space }
  })
  const activeGeneration = candidate.activeGeneration ?? null
  if (activeGeneration !== null && (!Number.isInteger(activeGeneration) || !spaces.some(space => space.generation === activeGeneration))) {
    throw new Error('嵌入空间 active 指针无效，未修改现有向量表')
  }
  return { version: 1, activeGeneration, spaces }
}

export function readRegistry(projectPath: string): EmbeddingSpaceRegistry | undefined {
  const filePath = registryPath(projectPath)
  if (!fs.existsSync(filePath)) return undefined
  try {
    return validateRegistry(JSON.parse(fs.readFileSync(filePath, 'utf8')))
  } catch (error) {
    if (error instanceof Error && error.message.includes('嵌入空间')) throw error
    throw new Error('嵌入空间元数据无法读取，未修改现有向量表')
  }
}

export function writeJsonAtomically(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.renameSync(temporaryPath, filePath)
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true })
  }
}

export function writeRegistry(projectPath: string, registry: EmbeddingSpaceRegistry): void {
  writeJsonAtomically(registryPath(projectPath), registry)
}

export async function inferLegacyRegistry(
  db: lancedb.Connection,
  tableNames: string[],
): Promise<EmbeddingSpaceRegistry> {
  const registry = emptyRegistry()
  if (tableNames.includes(TABLE_NAME)) {
    const legacyTable = await db.openTable(TABLE_NAME)
    const dimension = await vectorDimensionFromTable(legacyTable)
    if (dimension !== undefined) {
      registry.activeGeneration = 0
      registry.spaces.push({
        generation: 0,
        tableName: TABLE_NAME,
        modelFingerprint: LEGACY_MODEL_FINGERPRINT,
        vectorDimension: dimension,
        distanceMetric: DEFAULT_DISTANCE_METRIC,
        status: 'active',
        createdAt: new Date().toISOString(),
      })
    }
  }
  return registry
}

export async function loadOrRegisterLegacyRegistry(
  projectPath: string,
  db: lancedb.Connection,
  tableNames: string[],
): Promise<EmbeddingSpaceRegistry> {
  const stored = readRegistry(projectPath)
  if (stored) return stored

  const registry = await inferLegacyRegistry(db, tableNames)
  if (registry.spaces.length > 0) {
    // 只登记，不转换、更名或删除旧表。
    writeRegistry(projectPath, registry)
  }
  return registry
}

/** 读取当前元数据；旧 2048 表会在这里安全登记为 legacy 空间。 */
export async function getEmbeddingSpaces(projectPath: string): Promise<EmbeddingSpaceRegistry> {
  const db = await getConnection(projectPath)
  const registry = await loadOrRegisterLegacyRegistry(projectPath, db, await db.tableNames())
  return {
    ...registry,
    spaces: registry.spaces.map(space => ({ ...space })),
  }
}

export function matchingSpace(
  registry: EmbeddingSpaceRegistry,
  identity: Required<EmbeddingSpaceIdentity>,
  dimension: number,
): EmbeddingSpace | undefined {
  return registry.spaces.find(space => (
    space.modelFingerprint === identity.modelFingerprint
    && space.distanceMetric === identity.distanceMetric
    && space.vectorDimension === dimension
  ))
}

export function nextSpace(registry: EmbeddingSpaceRegistry, identity: Required<EmbeddingSpaceIdentity>, dimension: number): EmbeddingSpace {
  const generation = Math.max(0, ...registry.spaces.map(space => space.generation)) + 1
  return {
    generation,
    tableName: `${EMBEDDING_TABLE_PREFIX}${generation}`,
    modelFingerprint: identity.modelFingerprint,
    distanceMetric: identity.distanceMetric,
    vectorDimension: dimension,
    status: 'building',
    createdAt: new Date().toISOString(),
  }
}

export function registryWithActiveGeneration(
  registry: EmbeddingSpaceRegistry,
  generation: number,
): EmbeddingSpaceRegistry {
  return {
    version: 1,
    activeGeneration: generation,
    spaces: registry.spaces.map((space) => ({
      ...space,
      status: space.generation === generation
        ? 'active'
        : space.status === 'active'
          ? 'inactive'
          : space.status,
    })),
  }
}

/**
 * Canonical text can outgrow every existing vector generation when an import
 * falls back to FTS-only.  Persist this conservative transition before any
 * canonical write: a crash may lose vector acceleration, but never exposes an
 * active generation that omits newly committed canonical rows.
 */
export function registryWithNoActiveGeneration(registry: EmbeddingSpaceRegistry): EmbeddingSpaceRegistry {
  return {
    version: 1,
    activeGeneration: null,
    spaces: registry.spaces.map((space) => ({
      ...space,
      status: space.status === 'active' ? 'inactive' : space.status,
    })),
  }
}

export function activeSpace(registry: EmbeddingSpaceRegistry): EmbeddingSpace | undefined {
  return registry.activeGeneration === null
    ? undefined
    : registry.spaces.find(space => space.generation === registry.activeGeneration)
}
