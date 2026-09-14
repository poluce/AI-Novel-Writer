export const TOOL_RESULT_MAX_CHARS = 3000

/** Keep tool observations inside the historic 3000-character cap. */
export function truncateToolText(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text
  return `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n…`
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
