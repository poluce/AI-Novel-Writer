import { describe, expect, it } from 'vitest'

import {
  formatDraftPassageCitations,
  replaceExactOnce,
} from '../draft-excerpt'

describe('draft excerpt replace', () => {
  it('replaces a unique excerpt once', () => {
    expect(replaceExactOnce('顾舟停在潮门口。风很大。', '顾舟停在潮门口。', '顾舟在潮门口停了一停。'))
      .toEqual({ ok: true, next: '顾舟在潮门口停了一停。风很大。' })
  })

  it('fails when the excerpt is missing', () => {
    expect(replaceExactOnce('顾舟走了。', '林舟走了。', '林舟离开了。'))
      .toEqual({ ok: false, reason: 'not_found' })
  })

  it('fails when the excerpt is ambiguous', () => {
    expect(replaceExactOnce('他走了。他走了。', '他走了。', '他离开了。'))
      .toEqual({ ok: false, reason: 'ambiguous' })
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
