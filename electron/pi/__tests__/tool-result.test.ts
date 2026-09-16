import { describe, expect, it } from 'vitest'

import {
  truncateToolResultContent,
  truncateToolText,
} from '../tool-result'

describe('truncateToolText', () => {
  it('keeps short observations unchanged', () => {
    expect(truncateToolText('短结果')).toBe('短结果')
  })

  it('uses Pi-agent truncateHead to cap long observations without breaking lines', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `第 ${i + 1} 行正文内容`)
    const text = lines.join('\n')
    const truncated = truncateToolText(text)
    expect(truncated).toContain('第 1 行正文内容')
    expect(truncated).toContain('[… truncated')
    expect(truncated).toContain('lines')
  })

  it('honors byte boundaries when text exceeds byte limit', () => {
    const text = truncateToolText('一二三四五六七八九十', { maxBytes: 15, maxLines: 100 })
    expect(text).toContain('[… truncated')
  })
})

describe('truncateToolResultContent (applied by the afterToolCall hook)', () => {
  it('caps text blocks and leaves other content untouched', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `Line ${i + 1}`)
    const capped = truncateToolResultContent([
      { type: 'text', text: '短' },
      { type: 'text', text: lines.join('\n') },
      { type: 'image', data: 'abc' },
    ])

    expect(capped[0]).toEqual({ type: 'text', text: '短' })
    expect(capped[1].text!).toContain('[… truncated')
    expect(capped[2]).toEqual({ type: 'image', data: 'abc' })
  })
})
