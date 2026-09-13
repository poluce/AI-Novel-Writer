import type { WritingLanguage } from './writing-language'

export const MAX_DRAFT_ANNOTATIONS = 50
export const MAX_DRAFT_ANNOTATION_QUOTE = 2000
export const MAX_DRAFT_ANNOTATION_NOTE = 500

export interface DraftAnnotation {
  id: string
  from: number
  to: number
  quote: string
  note: string
  createdAt: number
}

export function isDraftAnnotation(value: unknown): value is DraftAnnotation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<DraftAnnotation>
  return typeof item.id === 'string'
    && item.id.length > 0
    && item.id.length <= 128
    && Number.isInteger(item.from)
    && Number.isInteger(item.to)
    && typeof item.quote === 'string'
    && item.quote.trim().length > 0
    && item.quote.length <= MAX_DRAFT_ANNOTATION_QUOTE
    && typeof item.note === 'string'
    && item.note.trim().length > 0
    && item.note.length <= MAX_DRAFT_ANNOTATION_NOTE
    && typeof item.createdAt === 'number'
    && Number.isFinite(item.createdAt)
}

export function parseDraftAnnotations(value: unknown): DraftAnnotation[] {
  if (!Array.isArray(value)) throw new Error('草稿标注格式无效')
  if (value.length > MAX_DRAFT_ANNOTATIONS) throw new Error('草稿标注数量超出限制')
  const annotations: DraftAnnotation[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!isDraftAnnotation(item)) throw new Error('草稿标注内容无效')
    if (seen.has(item.id)) throw new Error('草稿标注标识重复')
    seen.add(item.id)
    annotations.push({
      id: item.id,
      from: item.from,
      to: item.to,
      quote: item.quote,
      note: item.note.trim(),
      createdAt: item.createdAt,
    })
  }
  return annotations
}

export function formatDraftAnnotationsForRefine(
  annotations: readonly DraftAnnotation[],
  language: WritingLanguage,
): string {
  const usable = annotations.filter(item => item.note.trim() && item.quote.trim())
  if (usable.length === 0) return ''
  const heading = language === 'en-US'
    ? '[Author passage notes — highest priority. Revise these passages as requested, then submit the complete chapter.]'
    : '【作者选区标注——最高优先级。请按标注修改对应原文，并交出完整章节。】'
  const lines = usable.map((item, index) => (
    language === 'en-US'
      ? `${index + 1}. Original: 「${item.quote.trim()}」\n   Author note: ${item.note.trim()}`
      : `${index + 1}. 原文：「${item.quote.trim()}」\n   作者意见：${item.note.trim()}`
  ))
  return `${heading}\n${lines.join('\n')}`
}
