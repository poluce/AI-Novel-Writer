import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import type { RendererActionSink } from '../renderer-action'
import { MAX_DRAFT_EXCERPT_CHARS } from '../../../src/shared/draft-excerpt'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

const Schema = Type.Object({
  chapter_number: Type.Number(),
  old_text: Type.String(),
  new_text: Type.String(),
  draft_id: Type.Optional(Type.Number()),
})

export function createReplaceDraftExcerptTool(
  language: WritingLanguage,
  rendererAction: RendererActionSink,
): AgentTool<typeof Schema> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'Replace one exact excerpt in a chapter draft after confirmation. old_text must occur exactly once in the current draft body. Do not rewrite the whole chapter. Line numbers are display hints only — match the quoted prose.'
    : '在确认后，精确替换章节草稿中的一段原文。old_text 必须在当前草稿里只出现一次。不要整章重写。行号只是对照，匹配必须以原文为准。'

  return {
    name: 'replace_draft_excerpt',
    label: 'Replace Draft Excerpt',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const chapterNumber = params.chapter_number
      const oldText = params.old_text ?? ''
      const newText = params.new_text ?? ''
      if (!Number.isInteger(chapterNumber) || chapterNumber < 1) {
        throw new Error(text('chapter_number 必须是从 1 开始的整数', 'chapter_number must be an integer starting at 1'))
      }
      if (!oldText) {
        throw new Error(text('缺少 old_text', 'old_text is required'))
      }
      if (oldText.length > MAX_DRAFT_EXCERPT_CHARS || newText.length > MAX_DRAFT_EXCERPT_CHARS) {
        throw new Error(text(
          `替换片段过长（最多 ${MAX_DRAFT_EXCERPT_CHARS} 字）`,
          `The excerpt is too long (max ${MAX_DRAFT_EXCERPT_CHARS} characters)`,
        ))
      }

      const outcome = await rendererAction({
        type: 'replace_draft_excerpt',
        chapterNumber,
        oldText,
        newText,
        ...(params.draft_id == null ? {} : { draftId: params.draft_id }),
      })
      if (!outcome) {
        throw new Error(text('局部替换未能完成。', 'The passage replacement did not complete.'))
      }
      if (!outcome.ok) throw new Error(outcome.error)
      return {
        content: [{ type: 'text', text: outcome.summary }],
        details: {},
      }
    },
  }
}
