import { createHash } from 'node:crypto'
import type {
  ImportRunExecutionAuthority,
} from '../../src/shared/import-run'
import { SHA256 } from './import-run-schema'
import {
  db,
  assertExecutionAuthority,
  assertFrozenChapterSnapshot,
} from './import-run-store'

export function resolveReferenceImportAuthority(
    runId: string,
    authority: ImportRunExecutionAuthority,
    chapterNumber: number,
    now = Date.now(),
  ): {
    chapterNumber: number
    title: string
    content: string
    contentFingerprint: string
    stableKey: string
  } {
    const run = assertExecutionAuthority(runId, authority, now)
    if (
      run.purpose !== 'reference'
      || run.stage !== 'knowledge'
      || run.cancel_requested === 1
      || !Number.isSafeInteger(chapterNumber)
      || chapterNumber < 1
    ) {
      throw new Error('参照知识写入未绑定当前导入的冻结章节')
    }
    const chapter = db().prepare(`
      SELECT source_id, source_chapter_number, title, content_fingerprint, content_size, content_snapshot
      FROM import_run_chapters
      WHERE run_id = ? AND chapter_number = ?
    `).get(runId, chapterNumber) as {
      source_id: string
      source_chapter_number: number
      title: string
      content_fingerprint: string
      content_size: number
      content_snapshot: string
    } | undefined
    if (!chapter) throw new Error('参照知识写入未绑定当前导入的冻结章节')
    assertFrozenChapterSnapshot(chapter)
    const affiliationHash = createHash('sha256').update(JSON.stringify({
      purpose: run.purpose,
      sourceId: chapter.source_id,
      sourceChapterNumber: chapter.source_chapter_number,
      contentFingerprint: chapter.content_fingerprint,
    })).digest('hex')
    return {
      chapterNumber,
      title: chapter.title,
      content: chapter.content_snapshot,
      contentFingerprint: chapter.content_fingerprint,
      stableKey: `reference:${affiliationHash}`,
    }
  }

export function commitReferenceImportReceipt(
    runId: string,
    authority: ImportRunExecutionAuthority,
    chapterNumber: number,
    documentId: string,
  ): void {
    if (!SHA256.test(documentId)) throw new Error('参照知识文档身份无效')
    db().transaction(() => {
      const binding = resolveReferenceImportAuthority(runId, authority, chapterNumber)
      const expectedDocumentId = createHash('sha256')
        .update(`reference-import:${binding.stableKey}`, 'utf8')
        .digest('hex')
      const committedDocument = db().prepare(`
        SELECT document_id, content_hash, state
        FROM import_reference_documents WHERE document_id = ?
      `).get(expectedDocumentId) as {
        document_id: string
        content_hash: string
        state: string
      } | undefined
      if (
        documentId !== expectedDocumentId
        || committedDocument?.document_id !== expectedDocumentId
        || committedDocument.content_hash !== binding.contentFingerprint
        || committedDocument.state !== 'committed'
      ) throw new Error('参照知识文档尚未按冻结章节完整提交')
      const row = db().prepare(`
        SELECT source_id, source_chapter_number
        FROM import_run_chapters WHERE run_id = ? AND chapter_number = ?
      `).get(runId, chapterNumber) as { source_id: string; source_chapter_number: number }
      const existing = db().prepare(`
        SELECT document_id, purpose, source_id, source_chapter_number, content_fingerprint, state
        FROM import_run_knowledge_receipts WHERE run_id = ? AND chapter_number = ?
      `).get(runId, chapterNumber) as {
        document_id: string
        purpose: string
        source_id: string
        source_chapter_number: number
        content_fingerprint: string
        state: string
      } | undefined
      if (existing && (
        existing.document_id !== documentId
        || existing.purpose !== 'reference'
        || existing.source_id !== row.source_id
        || existing.source_chapter_number !== row.source_chapter_number
        || existing.content_fingerprint !== binding.contentFingerprint
        || existing.state !== 'committed'
      )) throw new Error('参照知识 receipt 已绑定不同效果')
      if (!existing) db().prepare(`
        INSERT INTO import_run_knowledge_receipts (
          run_id, chapter_number, purpose, source_id, source_chapter_number,
          content_fingerprint, document_id, state
        ) VALUES (?, ?, 'reference', ?, ?, ?, ?, 'committed')
      `).run(
        runId,
        chapterNumber,
        row.source_id,
        row.source_chapter_number,
        binding.contentFingerprint,
        documentId,
      )
    })()
  }
