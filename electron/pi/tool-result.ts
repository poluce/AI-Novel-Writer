import { truncateHead } from '@earendil-works/pi-agent-core'

/**
 * 工具观测结果的安全字符与字节上限。
 * 基于 @earendil-works/pi-agent-core 的原生 truncateHead 实现双重控制：
 * 绝不把单行截半，并返回包含截断行数与字节数的元数据提示。
 */
export const TOOL_RESULT_MAX_CHARS = 100_000
export const TOOL_RESULT_MAX_BYTES = 200_000
export const TOOL_RESULT_MAX_LINES = 2_000

export function truncateToolText(
  text: string,
  options?: { maxBytes?: number; maxLines?: number },
): string {
  const result = truncateHead(text, {
    maxBytes: options?.maxBytes ?? TOOL_RESULT_MAX_BYTES,
    maxLines: options?.maxLines ?? TOOL_RESULT_MAX_LINES,
  })
  if (!result.truncated) return result.content
  const truncatedCount = result.totalLines - result.outputLines
  return `${result.content}\n\n[… truncated ${truncatedCount > 0 ? `${truncatedCount} lines` : `${result.totalBytes - result.outputBytes} bytes`}]`
}

/** 把同一条工具结果里的文本块统一压到上限；非文本块原样保留。 */
export function truncateToolResultContent<T extends { type: string; text?: string }>(
  content: readonly T[],
): T[] {
  return content.map(block => (
    block.type === 'text' && typeof block.text === 'string'
      ? { ...block, text: truncateToolText(block.text) }
      : block
  ))
}
