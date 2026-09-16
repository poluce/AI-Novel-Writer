import type { Locale } from '../i18n/types'

/**
 * 把上游（或中转服务）返回的原始错误整理成一句能读懂的话。
 *
 * Gemini 适配器把错误又包了一层 JSON 字符串，界面上直接显示就是
 * `{"error":{"message":"{\n  \"error\": {\n    \"code\": 404, ...`。这里只做
 * 识别与转述，不做隐藏：认不出来的一律原样返回，免得把真实原因吞掉。
 */
export function describeProviderFailure(message: string, locale: Locale): string {
  const raw = message.trim()
  if (!raw) return ''
  const haystack = raw.toLowerCase()
  const pick = (zhCNText: string, enUSText: string): string => (
    locale === 'en-US' ? enUSText : zhCNText
  )

  if (haystack.includes('malformed_function_call')) {
    return pick(
      '模型这一轮生成的工具调用不合法，被上游中止了。重发一次通常就好；如果反复出现，换一个模型或把思考等级调低。',
      'The model produced a malformed tool call and the upstream stopped the turn. Retry, or switch model / lower the thinking level if it keeps happening.',
    )
  }

  if (haystack.includes('thinking level') && haystack.includes('not supported')) {
    return pick(
      '这个模型不接受当前的思考等级。在输入框的「思考」里改选低 / 中 / 高，或者换一个模型。',
      'This model rejects the current thinking level. Pick Low / Medium / High in the composer, or switch model.',
    )
  }

  if (
    haystack.includes('"code": 404')
    || haystack.includes('not_found')
    || haystack.includes('requested entity was not found')
  ) {
    return pick(
      '服务端没有这个模型（404）。模型名要跟端点提供的列表完全一致——有些服务只开放带后缀的变体（如 -low / -high），目录里列出不代表能调用。',
      'The service does not serve this model (404). The name must match its model list exactly; some endpoints only route suffixed variants (e.g. -low / -high).',
    )
  }

  if (haystack.includes('"code": 401') || haystack.includes('unauthenticated') || haystack.includes('api key not valid')) {
    return pick(
      'API Key 无效或已失效（401）。请在设置里重新填写。',
      'The API key is invalid or expired (401). Update it in Settings.',
    )
  }

  if (haystack.includes('"code": 403') || haystack.includes('permission_denied')) {
    return pick(
      '这个 Key 没有调用该模型的权限（403）。',
      'This key is not allowed to call that model (403).',
    )
  }

  if (haystack.includes('"code": 429') || haystack.includes('resource_exhausted') || haystack.includes('rate limit')) {
    return pick(
      '触发限流（429）。等一会儿再发，或换一个模型。',
      'Rate limited (429). Wait a moment or switch model.',
    )
  }

  if (haystack.includes('"code": 400') || haystack.includes('invalid_argument')) {
    return pick(
      '上游拒绝了这次请求（400）。如果刚换过模型，先试试另一个模型名。',
      'The upstream rejected the request (400). If you just switched models, try another model name.',
    )
  }

  if (haystack.includes('"code": 503') || haystack.includes('unavailable') || haystack.includes('overloaded')) {
    return pick(
      '上游暂时不可用（503）。这是服务端的问题，稍后重试。',
      'The upstream is temporarily unavailable (503). Retry later.',
    )
  }

  if (haystack.includes('stream ended without a finish reason')) {
    return pick(
      '上游的流式响应中途断了（没有结束原因）。通常是转接服务不稳定，重发一次即可。',
      'The upstream stream ended without a finish reason. Usually a flaky relay; just resend.',
    )
  }

  return raw
}
