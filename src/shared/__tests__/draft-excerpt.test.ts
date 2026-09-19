import { describe, expect, it } from 'vitest'

import {
  batchReplaceExcerpts,
  extractContextPreview,
  findMatchRange,
  formatDraftPassageCitations,
  replaceExactOnce,
} from '../draft-excerpt'

describe('draft excerpt replace', () => {
  it('replaces a unique excerpt once with context preview', () => {
    const res = replaceExactOnce('顾舟停在潮门口。风很大。', '顾舟停在潮门口。', '顾舟在潮门口停了一停。')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.next).toBe('顾舟在潮门口停了一停。风很大。')
      expect(res.preview).toContain('顾舟在潮门口停了一停。风很大。')
    }
  })

  it('fails when the excerpt is missing', () => {
    const res = replaceExactOnce('顾舟走了。', '林舟走了。', '林舟离开了。')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('not_found')
      expect(res.message).toContain('未在草稿中找到')
    }
  })

  it('fails when the excerpt is ambiguous', () => {
    const res = replaceExactOnce('他走了。他走了。', '他走了。', '他离开了。')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('ambiguous')
      expect(res.message).toContain('多次')
    }
  })

  it('tolerates CRLF vs LF and line trailing spaces', () => {
    const source = '第1行\r\n第2行有空格   \r\n第3行结束'
    const needle = '第1行\n第2行有空格\n第3行结束'
    const match = findMatchRange(source, needle)
    expect('match' in match).toBe(true)

    const res = replaceExactOnce(source, needle, '第1行\n第2行已修改\n第3行结束')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.next).toBe('第1行\n第2行已修改\n第3行结束')
    }
  })
})

describe('batch replace excerpts', () => {
  it('replaces multiple excerpts atomically from end to start', () => {
    const doc = [
      '第一行：凌晨两点。',
      '第二行：正常内容。',
      '第三行：凌晨两点二十分。',
      '第四行：结尾。',
    ].join('\n')

    const res = batchReplaceExcerpts(doc, [
      { old_text: '第一行：凌晨两点。', new_text: '第一行：夜里十一点。' },
      { old_text: '第三行：凌晨两点二十分。', new_text: '第三行：十一点半。' },
    ])

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.count).toBe(2)
      expect(res.next).toContain('第一行：夜里十一点。')
      expect(res.next).toContain('第三行：十一点半。')
      expect(res.previews).toHaveLength(2)
      expect(res.previews[0]).toContain('第一行：夜里十一点。')
      expect(res.previews[1]).toContain('第三行：十一点半。')
    }
  })

  it('rejects all replacements if any item is not found (atomic all-or-nothing)', () => {
    const doc = '小红在看书。小蓝在写字。'
    const res = batchReplaceExcerpts(doc, [
      { old_text: '小红在看书。', new_text: '小红在画画。' },
      { old_text: '不存在的句子', new_text: '无法替换' },
    ])

    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('not_found')
      expect(res.itemIndex).toBe(2)
      expect(res.failedText).toBe('不存在的句子')
    }
  })

  it('rejects overlapping replacements', () => {
    const doc = '今天天气晴朗万里无云'
    const res = batchReplaceExcerpts(doc, [
      { old_text: '天气晴朗', new_text: '阴天' },
      { old_text: '晴朗万里', new_text: '微风' },
    ])

    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('overlapping')
    }
  })
})

describe('extractContextPreview', () => {
  it('extracts surrounding lines with line numbers', () => {
    const text = ['行1', '行2', '行3', '行4', '行5'].join('\n')
    // '行3' starts at index 6, ends at 8
    const preview = extractContextPreview(text, 6, 8, 1)
    expect(preview.fromLine).toBe(2)
    expect(preview.toLine).toBe(4)
    expect(preview.preview).toContain('[第2行] 行2')
    expect(preview.preview).toContain('[第3行] 行3')
    expect(preview.preview).toContain('[第4行] 行4')
    expect(preview.preview).not.toContain('行1')
    expect(preview.preview).not.toContain('行5')
  })
})

describe('draft passage citations', () => {
  it('formats chapter and line labels for the assistant', () => {
    const block = formatDraftPassageCitations([{
      id: 'c1',
      chapterNumber: 3,
      version: 2,
      fromLine: 41,
      toLine: 44,
      quote: '他走了。',
    }], 'zh-CN')
    expect(block).toContain('【草稿引用 — 第3章 · v2 · 第41–44行】')
    expect(block).toContain('「他走了。」')
  })
})
