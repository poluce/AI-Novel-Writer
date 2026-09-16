/** One-shot submit_* tool names shared by renderer commands and the main process. */
export const SUBMIT_TOOL_NAMES = [
  'submit_draft',
  'submit_revision',
  'submit_finalization',
  'submit_review',
  'submit_outline',
  'submit_blueprint',
  'submit_field',
  'submit_style_analysis',
  'submit_text',
  'submit_json',
  'submit_novel_config',
] as const

export type SubmitToolName = typeof SUBMIT_TOOL_NAMES[number]

export function isSubmitToolName(value: unknown): value is SubmitToolName {
  return typeof value === 'string'
    && (SUBMIT_TOOL_NAMES as readonly string[]).includes(value)
}
