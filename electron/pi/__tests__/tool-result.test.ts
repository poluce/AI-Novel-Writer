import { describe, expect, it } from 'vitest'

import { TOOL_RESULT_MAX_CHARS, truncateToolText } from '../tool-result'

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
