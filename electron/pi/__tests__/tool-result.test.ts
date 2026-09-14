import { describe, expect, it } from 'vitest'

import {
  TOOL_RESULT_MAX_CHARS,
  truncateToolResultContent,
  truncateToolText,
} from '../tool-result'

describe('truncateToolText', () => {
  it('keeps short observations unchanged', () => {
    expect(truncateToolText('短结果')).toBe('短结果')
  })

  it('caps observations at 3000 characters', () => {
    const text = '字'.repeat(TOOL_RESULT_MAX_CHARS + 80)
    const truncated = truncateToolText(text)
    expect(truncated.startsWith('字'.repeat(TOOL_RESULT_MAX_CHARS))).toBe(true)
    expect(truncated.endsWith('\n…')).toBe(true)
    expect(truncated.length).toBe(TOOL_RESULT_MAX_CHARS + 2)
  })
})

describe('truncateToolResultContent (applied by the afterToolCall hook)', () => {
  it('caps text blocks and leaves other content untouched', () => {
    const capped = truncateToolResultContent([
      { type: 'text', text: '短' },
      { type: 'text', text: '长'.repeat(TOOL_RESULT_MAX_CHARS + 5) },
      { type: 'image', data: 'abc' },
    ])

    expect(capped[0]).toEqual({ type: 'text', text: '短' })
    expect(capped[1].text!.length).toBe(TOOL_RESULT_MAX_CHARS + 2)
    expect(capped[2]).toEqual({ type: 'image', data: 'abc' })
  })
})
