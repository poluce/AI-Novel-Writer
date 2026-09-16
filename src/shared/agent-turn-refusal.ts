import type { Locale } from '../i18n/types'

/**
 * 主进程**主动拒绝**这一轮的原因码。
 *
 * 供应商/中转服务报的错走事件通道（`agent:event` 的 error），那边的原文由
 * `describeProviderFailure` 翻译；这里只覆盖"我们自己的判断"——比如要换运行时
 * 但上一轮还没跑完。分开的理由是不把两边的文案混在一起，也避免把未知异常的
 * 内部文本直接甩到对话气泡里。
 */
export const AGENT_TURN_REFUSAL_CODES = [
  'model-missing',
  'session-store-unavailable',
  'session-busy',
  'switch-failed',
] as const

export type AgentTurnRefusalCode = typeof AGENT_TURN_REFUSAL_CODES[number]

export function isAgentTurnRefusalCode(value: unknown): value is AgentTurnRefusalCode {
  return typeof value === 'string'
    && (AGENT_TURN_REFUSAL_CODES as readonly string[]).includes(value)
}

/** 把拒绝原因码翻成一句给用户看的话。 */
export function describeAgentTurnRefusal(code: AgentTurnRefusalCode, locale: Locale): string {
  const pick = (zhCNText: string, enUSText: string): string => (
    locale === 'en-US' ? enUSText : zhCNText
  )
  switch (code) {
    case 'model-missing':
      return pick(
        '没有找到可用的模型。请在设置里添加或选择一个模型。',
        'No usable model was found. Add or pick one in Settings.',
      )
    case 'session-store-unavailable':
      return pick(
        '这个会话的存档打不开，暂时没法继续对话。',
        'The conversation archive could not be opened, so the turn cannot continue.',
      )
    case 'session-busy':
      return pick(
        '这一轮还在生成，等它结束后再切换模型或思考等级。',
        'This turn is still running. Switch model or thinking level after it finishes.',
      )
    case 'switch-failed':
      return pick(
        '会话没能安全切换，请重发一次。',
        'The conversation could not be switched safely. Send the message again.',
      )
  }
}
