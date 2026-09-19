import { getProjectDb } from '../database'
import {
  parseDraftAnnotations,
  type DraftAnnotation,
} from '../../src/shared/draft-annotation'

interface DraftAnnotationRow {
  id: string
  draft_id: number
  start_offset: number
  end_offset: number
  quote: string
  note: string
  resolved?: number
  created_at: number
}

function rowToAnnotation(row: DraftAnnotationRow): DraftAnnotation {
  return {
    id: row.id,
    from: row.start_offset,
    to: row.end_offset,
    quote: row.quote,
    note: row.note,
    resolved: Boolean(row.resolved),
    createdAt: row.created_at,
  }
}

export class DraftAnnotationRepository {
  /**
   * 查询草稿批注列表。默认只返回待处理（未解决）的批注；
   * 若传 includeResolved: true 则返回包括已归档在内的全部批注。
   */
  static list(draftId: number, options?: { includeResolved?: boolean }): DraftAnnotation[] {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    const filterResolved = options?.includeResolved ? '' : 'AND (resolved IS NULL OR resolved = 0)'
    const rows = db.prepare(`
      SELECT id, draft_id, start_offset, end_offset, quote, note, resolved, created_at
      FROM draft_annotations
      WHERE draft_id = ? ${filterResolved}
      ORDER BY created_at ASC, id ASC
    `).all(draftId) as DraftAnnotationRow[]
    return parseDraftAnnotations(rows.map(rowToAnnotation))
  }

  /**
   * 将指定批注标记为已解决（归档）。
   * 若 annotationIds 为 'all' 或未指定，则将该草稿的所有未解决批注全部标记为已解决。
   */
  static resolve(draftId: number, annotationIds?: string[] | 'all'): number {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    if (!annotationIds || annotationIds === 'all') {
      const res = db.prepare('UPDATE draft_annotations SET resolved = 1 WHERE draft_id = ? AND (resolved IS NULL OR resolved = 0)').run(draftId)
      return res.changes
    }
    if (annotationIds.length === 0) return 0
    const placeholders = annotationIds.map(() => '?').join(',')
    const res = db.prepare(`
      UPDATE draft_annotations
      SET resolved = 1
      WHERE draft_id = ? AND id IN (${placeholders}) AND (resolved IS NULL OR resolved = 0)
    `).run(draftId, ...annotationIds)
    return res.changes
  }

  static replace(draftId: number, annotations: readonly DraftAnnotation[]): void {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    const draft = db.prepare('SELECT id FROM drafts WHERE id = ?').get(draftId) as { id: number } | undefined
    if (!draft) throw new Error(`草稿不存在：${draftId}`)
    const parsed = parseDraftAnnotations(annotations)
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM draft_annotations WHERE draft_id = ?').run(draftId)
      const insert = db.prepare(`
        INSERT INTO draft_annotations (id, draft_id, start_offset, end_offset, quote, note, resolved, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const item of parsed) {
        insert.run(item.id, draftId, item.from, item.to, item.quote, item.note, item.resolved ? 1 : 0, item.createdAt)
      }
    })
    tx()
  }
}
