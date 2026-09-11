export const TOOL_RESULT_MAX_CHARS = 3000

/** Keep tool observations inside the historic 3000-character cap. */
export function truncateToolText(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text
  return `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n…`
}
