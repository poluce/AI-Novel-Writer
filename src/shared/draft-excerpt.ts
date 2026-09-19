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
  | { ok: true; next: string; preview?: string }
  | { ok: false; reason: 'empty' | 'not_found' | 'ambiguous' | 'overlapping'; itemIndex?: number; message?: string }

export interface ExcerptReplacementItem {
  old_text: string
  new_text: string
}

export type BatchReplaceResult =
  | {
      ok: true
      next: string
      count: number
      previews: string[]
    }
  | {
      ok: false
      reason: 'empty' | 'not_found' | 'ambiguous' | 'overlapping'
      itemIndex: number
      failedText: string
      message: string
    }

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

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

export interface MatchRangeResult {
  start: number
  end: number
  matchedProse: string
}

/**
 * 查找匹配区间：
 * 1. 优先严格全等字面匹配；
 * 2. 未命中时，自动启用换行符（CRLF/LF）与每行行首行尾空白弱容错匹配；
 * 3. 严格遵循唯一性规则：命中 0 次返回 not_found，命中 >1 次返回 ambiguous。
 */
export function findMatchRange(
  source: string,
  oldText: string,
): { match: MatchRangeResult } | { error: 'empty' | 'not_found' | 'ambiguous' } {
  const trimmed = oldText.trim()
  if (!trimmed) return { error: 'empty' }

  // 1. 优先尝试严格字面匹配
  const exactCount = countExactOccurrences(source, oldText)
  if (exactCount === 1) {
    const start = source.indexOf(oldText)
    return {
      match: {
        start,
        end: start + oldText.length,
        matchedProse: oldText,
      },
    }
  }
  if (exactCount > 1) {
    return { error: 'ambiguous' }
  }

  // 2. 严格匹配未命中时：启用换行符与行末不可见空白容错
  const lines = oldText.split(/\r?\n/)
  if (lines.length > 1) {
    const patternStr = lines
      .map(line => escapeRegExp(line.trim()))
      .filter(Boolean)
      .join('[ \\t]*\\r?\\n[ \\t]*')

    try {
      const regex = new RegExp(patternStr, 'g')
      const matches = Array.from(source.matchAll(regex))
      if (matches.length === 1 && matches[0].index !== undefined) {
        const start = matches[0].index
        const matchedStr = matches[0][0]
        return {
          match: {
            start,
            end: start + matchedStr.length,
            matchedProse: matchedStr,
          },
        }
      }
      if (matches.length > 1) {
        return { error: 'ambiguous' }
      }
    } catch {
      // 容错异常直接忽略，退化为 not_found
    }
  } else {
    // 单行两端空白容错
    const trimmedNeedle = oldText.trim()
    const singleLinePattern = `[ \\t]*${escapeRegExp(trimmedNeedle)}[ \\t]*`
    try {
      const regex = new RegExp(singleLinePattern, 'g')
      const matches = Array.from(source.matchAll(regex))
      if (matches.length === 1 && matches[0].index !== undefined) {
        const start = matches[0].index
        const matchedStr = matches[0][0]
        return {
          match: {
            start,
            end: start + matchedStr.length,
            matchedProse: matchedStr,
          },
        }
      }
      if (matches.length > 1) {
        return { error: 'ambiguous' }
      }
    } catch {
      // 忽略
    }
  }

  return { error: 'not_found' }
}

/**
 * 提取替换发生处周围指定行数的带行号上下文预览切片
 */
export function extractContextPreview(
  doc: string,
  startIndex: number,
  endIndex: number,
  surroundingLines = 2,
): { fromLine: number; toLine: number; preview: string } {
  const allLines = doc.split('\n')
  if (allLines.length === 0) {
    return { fromLine: 1, toLine: 1, preview: '' }
  }

  let currentOffset = 0
  let targetStartLine = 1
  let targetEndLine = 1

  for (let i = 0; i < allLines.length; i++) {
    const lineLength = allLines[i].length + 1 // 算上 \n
    if (startIndex >= currentOffset && startIndex < currentOffset + lineLength) {
      targetStartLine = i + 1
    }
    if (endIndex >= currentOffset && endIndex <= currentOffset + lineLength) {
      targetEndLine = i + 1
      break
    }
    currentOffset += lineLength
  }

  const startLineIdx = Math.max(0, targetStartLine - 1 - surroundingLines)
  const endLineIdx = Math.min(allLines.length, targetEndLine + surroundingLines)
  const slice = allLines.slice(startLineIdx, endLineIdx)

  const preview = slice
    .map((lineText, idx) => {
      const lineNum = startLineIdx + idx + 1
      return `[第${lineNum}行] ${lineText}`
    })
    .join('\n')

  return {
    fromLine: startLineIdx + 1,
    toLine: endLineIdx,
    preview,
  }
}

/**
 * 批量替换多处原文（全原子性）：
 * - 先验证全部项在正文中均存在、且唯一命中、区间互不重叠；
 * - 全部通过后，从文档尾部倒序执行替换，保证物理字符偏移不发生错位；
 * - 替换后为每一处改动生成带行号的局部上下文预览切片返回。
 */
export function batchReplaceExcerpts(
  source: string,
  replacements: readonly ExcerptReplacementItem[],
): BatchReplaceResult {
  if (!replacements || replacements.length === 0) {
    return {
      ok: false,
      reason: 'empty',
      itemIndex: 0,
      failedText: '',
      message: '替换列表不能为空',
    }
  }

  interface MatchedItem {
    index: number
    start: number
    end: number
    oldText: string
    newText: string
  }

  const matchedItems: MatchedItem[] = []

  for (let i = 0; i < replacements.length; i++) {
    const item = replacements[i]
    if (!item.old_text) {
      return {
        ok: false,
        reason: 'empty',
        itemIndex: i + 1,
        failedText: '',
        message: `第 ${i + 1} 项要替换的原文为空`,
      }
    }

    const matchRes = findMatchRange(source, item.old_text)
    if ('error' in matchRes) {
      if (matchRes.error === 'not_found') {
        return {
          ok: false,
          reason: 'not_found',
          itemIndex: i + 1,
          failedText: item.old_text,
          message: `第 ${i + 1} 项原文未在草稿中找到：「${item.old_text.slice(0, 40)}${item.old_text.length > 40 ? '…' : ''}」`,
        }
      }
      if (matchRes.error === 'ambiguous') {
        return {
          ok: false,
          reason: 'ambiguous',
          itemIndex: i + 1,
          failedText: item.old_text,
          message: `第 ${i + 1} 项原文在草稿中出现了多次，匹配不唯一。请多补充上下文：「${item.old_text.slice(0, 40)}」`,
        }
      }
      return {
        ok: false,
        reason: 'empty',
        itemIndex: i + 1,
        failedText: '',
        message: `第 ${i + 1} 项替换原文无效`,
      }
    }

    matchedItems.push({
      index: i,
      start: matchRes.match.start,
      end: matchRes.match.end,
      oldText: item.old_text,
      newText: item.new_text ?? '',
    })
  }

  // 检查区间重叠
  const sortedByStart = [...matchedItems].sort((a, b) => a.start - b.start)
  for (let j = 0; j < sortedByStart.length - 1; j++) {
    const current = sortedByStart[j]
    const next = sortedByStart[j + 1]
    if (current.end > next.start) {
      return {
        ok: false,
        reason: 'overlapping',
        itemIndex: next.index + 1,
        failedText: next.oldText,
        message: `第 ${current.index + 1} 项与第 ${next.index + 1} 项的替换区间发生重叠冲突，无法同时应用`,
      }
    }
  }

  // 倒序替换
  const sortedDescending = [...matchedItems].sort((a, b) => b.start - a.start)
  let currentDoc = source

  for (const item of sortedDescending) {
    currentDoc = `${currentDoc.slice(0, item.start)}${item.newText}${currentDoc.slice(item.end)}`
  }

  // 为每个替换生成在修改后正文中的切片预览
  const previews: string[] = []
  let searchOffset = 0
  for (const item of matchedItems) {
    const newText = item.newText
    let newStart = -1
    if (newText) {
      newStart = currentDoc.indexOf(newText, searchOffset)
    }
    if (newStart < 0) {
      newStart = Math.min(item.start, currentDoc.length)
    }
    const newEnd = newStart + (newText ? newText.length : 0)
    searchOffset = newEnd

    const previewInfo = extractContextPreview(currentDoc, newStart, newEnd, 2)
    previews.push(previewInfo.preview)
  }

  return {
    ok: true,
    next: currentDoc,
    count: replacements.length,
    previews,
  }
}

/** 单处替换（基于批处理逻辑） */
export function replaceExactOnce(source: string, oldText: string, newText: string): ExactReplaceResult {
  const batchRes = batchReplaceExcerpts(source, [{ old_text: oldText, new_text: newText }])
  if (!batchRes.ok) {
    return { ok: false, reason: batchRes.reason, message: batchRes.message }
  }
  return {
    ok: true,
    next: batchRes.next,
    preview: batchRes.previews[0],
  }
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
