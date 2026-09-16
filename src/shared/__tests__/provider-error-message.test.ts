import { describe, expect, it } from 'vitest'

import { describeProviderFailure } from '../provider-error-message'

/** 上游把错误包成假 JSON 字符串，界面上原来显示的就是这一坨。 */
const notFound = '{"error":{"message":"{\\n  \\"error\\": {\\n    \\"code\\": 404,\\n    \\"message\\": \\"Requested entity was not found.\\",\\n    \\"status\\": \\"NOT_FOUND\\"\\n  }\\n}\\n","code":404,"status":"Not Found"}}'

describe('describeProviderFailure', () => {
  it('turns the 404 model-not-routed payload into a readable sentence', () => {
    const text = describeProviderFailure(notFound, 'zh-CN')
    expect(text).toContain('404')
    expect(text).toContain('模型名')
    expect(text).not.toContain('NOT_FOUND')
  })

  it('explains a rejected thinking level and says what to change', () => {
    const text = describeProviderFailure(
      '{"error":{"message":"Thinking level MINIMAL is not supported for this model. Please retry with other thinking level.","code":400}}',
      'zh-CN',
    )
    expect(text).toContain('思考')
    expect(text).toContain('低')
  })

  it('explains a malformed function call without blaming the user', () => {
    const text = describeProviderFailure('Provider stopped with: MALFORMED_FUNCTION_CALL', 'zh-CN')
    expect(text).toContain('工具调用')
  })

  it('keeps the upstream copy for an English UI', () => {
    expect(describeProviderFailure(notFound, 'en-US')).toContain('404')
    expect(describeProviderFailure(notFound, 'en-US')).toContain('model list')
  })

  it('returns an unknown failure unchanged instead of hiding it', () => {
    expect(describeProviderFailure('boom: 未知错误', 'zh-CN')).toBe('boom: 未知错误')
    expect(describeProviderFailure('', 'zh-CN')).toBe('')
  })
})
