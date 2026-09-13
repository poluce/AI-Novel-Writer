import type { WritingLanguage } from './writing-language'

export const MAX_DRAFT_EXCERPT_CHARS = 8_000

export interface DraftPassageCitation {
  id: string
  chapterNumber?: number
  draftId?: number
  version?: number
  fromLine: number
  toLine: number
  quote: string
  filePath?: string
}

export type ExactReplaceResult =
  | { ok: true; next: string }
  | { ok: false; reason: 'empty' | 'not_found' | 'ambiguous' }

export function countExactOccurrences(source: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let from = 0
  while (from <= source.length - needle.length) {
    const index = source.indexOf(needle, from)
    if (index < 0) break
    count += 1
    from = index + needle.length
  }
  return count
}

export function replaceExactOnce(source: string, oldText: string, newText: string): ExactReplaceResult {
  if (!oldText) return { ok: false, reason: 'empty' }
  const count = countExactOccurrences(source, oldText)
  if (count === 0) return { ok: false, reason: 'not_found' }
  if (count > 1) return { ok: false, reason: 'ambiguous' }
  const index = source.indexOf(oldText)
  return { ok: true, next: `${source.slice(0, index)}${newText}${source.slice(index + oldText.length)}` }
}

export function formatDraftPassageCitations(
  citations: readonly DraftPassageCitation[],
  language: WritingLanguage,
): string {
  if (citations.length === 0) return ''
  return citations.map((citation) => {
    const location = [
      citation.chapterNumber != null
        ? (language === 'en-US' ? `Chapter ${citation.chapterNumber}` : `第${citation.chapterNumber}章`)
        : '',
      citation.version != null ? `v${citation.version}` : '',
      citation.fromLine > 0
        ? (language === 'en-US'
          ? (citation.toLine > citation.fromLine
            ? `lines ${citation.fromLine}–${citation.toLine}`
            : `line ${citation.fromLine}`)
          : (citation.toLine > citation.fromLine
            ? `第${citation.fromLine}–${citation.toLine}行`
            : `第${citation.fromLine}行`))
        : '',
    ].filter(Boolean).join(' · ')
    const heading = language === 'en-US'
      ? `[Draft excerpt${location ? ` — ${location}` : ''}]`
      : `【草稿引用${location ? ` — ${location}` : ''}】`
    return `${heading}\n「${citation.quote}」`
  }).join('\n\n')
}
