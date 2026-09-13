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
  created_at: number
}

function rowToAnnotation(row: DraftAnnotationRow): DraftAnnotation {
  return {
    id: row.id,
    from: row.start_offset,
    to: row.end_offset,
    quote: row.quote,
    note: row.note,
    createdAt: row.created_at,
  }
}

export class DraftAnnotationRepository {
  static list(draftId: number): DraftAnnotation[] {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    const rows = db.prepare(`
      SELECT id, draft_id, start_offset, end_offset, quote, note, created_at
      FROM draft_annotations
      WHERE draft_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(draftId) as DraftAnnotationRow[]
    return parseDraftAnnotations(rows.map(rowToAnnotation))
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
        INSERT INTO draft_annotations (id, draft_id, start_offset, end_offset, quote, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      for (const item of parsed) {
        insert.run(item.id, draftId, item.from, item.to, item.quote, item.note, item.createdAt)
      }
    })
    tx()
  }
}
