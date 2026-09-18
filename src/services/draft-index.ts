/**
 * 草稿元数据管理（原 index.json 封装层）
 *
 * 全量 DB 化后，这里不再读写 index.json，而是直接桥接到 db:* IPC 通道。
 * 保留原有函数名和数据接口结构，以便减少对 UI 层 (DraftEditor) 的破坏性修改。
 */
import { ipc } from './ipc-client'
import type { DraftStatus } from '../shared/draft-status'

// 导入后端的类型定义
import type { DraftMeta as DB_DraftMeta } from '../shared/contracts/draft'
import type { RevisionMeta as DB_RevisionMeta } from '../shared/contracts/revision'
import type { ReviewMeta as DB_ReviewMeta } from '../shared/contracts/review'

// ===== DraftMeta 兼容类型 =====
export interface DraftMeta {
  id: number
  chapterNumber: number
  chapterTitle?: string       // finalized outbox 的权威标题；旧定稿或未定稿可为空
  version: number
  status: DraftStatus
  wordCount?: number
  createdAt: string
  updatedAt?: string
  source: 'write' | 'rewrite'

  // 为了尽量不改 UI，我们伪造这两个字段
  filePath: string
  fileName: string
}

// ===== RevisionEntry 兼容类型 =====
export interface RevisionEntry {
  id: number
  baseDraftId: number
  baseVersion: number         // 为了 UI 需要保留关联版本号
  revisionIndex: number
  type: 'refine' | 'review-fix'
  status: 'pending' | 'merged' | 'discarded'
  createdAt: string
  mergedToDraftId?: number
}

// ===== ReviewEntry 兼容类型 =====
export interface ReviewEntry {
  id: number
  baseDraftId: number
  baseVersion: number
  reviewIndex: number
  createdAt: string
}

// ==========================================
// 辅助映射函数
// ==========================================

function mapRevisionEntry(dbMeta: DB_RevisionMeta, baseVersion: number): RevisionEntry {
  return {
    ...dbMeta,
    type: dbMeta.revisionType as 'refine' | 'review-fix',
    status: dbMeta.status as 'pending' | 'merged' | 'discarded',
    mergedToDraftId: dbMeta.mergedToDraftId ?? undefined,
    baseVersion,
  }
}

function mapReviewEntry(dbMeta: DB_ReviewMeta, baseVersion: number): ReviewEntry {
  return {
    ...dbMeta,
    baseVersion,
  }
}

// Helper: 查出 draftId
async function getDraftId(chapterNumber: number, version: number, expectedProjectPath: string): Promise<number | null> {
  const drafts = await ipc.invoke('db:draft-list', chapterNumber, expectedProjectPath)
  const match = drafts.find((d: DB_DraftMeta) => d.version === version)
  return match?.id ?? null
}

// ==========================================
// 草稿操作
// ==========================================

// ==========================================
// 修稿操作
// ==========================================

export async function getPendingRevisions(
  chapterDir: string,
  baseVersion: number,
  expectedProjectPath: string,
): Promise<RevisionEntry[]> {
  const match = chapterDir.match(/ch(\d+)$/)
  if (!match) return []
  const chapterNumber = parseInt(match[1])

  const draftId = await getDraftId(chapterNumber, baseVersion, expectedProjectPath)
  if (!draftId) return []

  const list: DB_RevisionMeta[] = await ipc.invoke('db:revision-get-pending', draftId, expectedProjectPath)
  return list.map(m => mapRevisionEntry(m, baseVersion))
}

// ==========================================
// 审稿操作
// ==========================================

export async function getLatestReview(
  chapterDir: string,
  baseVersion: number,
  expectedProjectPath: string,
): Promise<ReviewEntry | null> {
  const matchCh = chapterDir.match(/ch(\d+)$/)
  if (!matchCh) return null
  const chapterNumber = parseInt(matchCh[1])

  const baseDraftId = await getDraftId(chapterNumber, baseVersion, expectedProjectPath)
  if (!baseDraftId) return null

  const review: DB_ReviewMeta | null = await ipc.invoke('db:review-get-latest', baseDraftId, expectedProjectPath)
  if (!review) return null

  return mapReviewEntry(review, baseVersion)
}

export async function getReviewsForVersion(
  chapterDir: string,
  baseVersion: number,
  expectedProjectPath: string,
): Promise<ReviewEntry[]> {
  const matchCh = chapterDir.match(/ch(\d+)$/)
  if (!matchCh) return []
  const chapterNumber = parseInt(matchCh[1])

  const baseDraftId = await getDraftId(chapterNumber, baseVersion, expectedProjectPath)
  if (!baseDraftId) return []

  const list: DB_ReviewMeta[] = await ipc.invoke('db:review-list', baseDraftId, expectedProjectPath)
  return list.map(m => mapReviewEntry(m, baseVersion)).sort((a, b) => a.reviewIndex - b.reviewIndex)
}
