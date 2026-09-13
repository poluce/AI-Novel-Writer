import { describe, expect, it } from 'vitest'

import { formatDraftAnnotationsForRefine, parseDraftAnnotations } from '../draft-annotation'

describe('draft annotations', () => {
  it('formats author passage notes for the refine prompt', () => {
    const text = formatDraftAnnotationsForRefine([
      {
        id: 'a1',
        from: 0,
        to: 4,
        quote: '他走了',
        note: '动作太空，补一个停顿',
        createdAt: 1,
      },
    ], 'zh-CN')
    expect(text).toContain('作者选区标注')
    expect(text).toContain('原文：「他走了」')
    expect(text).toContain('作者意见：动作太空，补一个停顿')
  })

  it('rejects an empty note', () => {
    expect(() => parseDraftAnnotations([{
      id: 'a1',
      from: 0,
      to: 2,
      quote: '原文',
      note: '   ',
      createdAt: 1,
    }])).toThrow(/无效/)
  })
})
