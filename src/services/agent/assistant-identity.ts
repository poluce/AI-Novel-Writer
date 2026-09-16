import { writingLanguageText, type WritingLanguage } from '../../shared/writing-language'
import {
  composePromptSystemRole,
  renderPrompt,
  type PromptTemplate,
} from '../prompt-templates'

export const ASSISTANT_WRITING_IDENTITY_KEY = 'assistant_writing_identity'

/**
 * Pi-specific operating note interpolated into `{{mode_instruction}}`.
 * Creative role/guidance still come from the settings template.
 */
export function appShellModeInstruction(language: WritingLanguage): string {
  return writingLanguageText(
    language,
    '系统上下文包含当前应用状态（是否打开小说、侧栏/对话框、编辑器与工作流）。请以该状态为准；未打开项目时不要假装能读写该书。不要编造项目事实。',
    'The system context contains the current app state (whether a novel is open, which panes and dialogs are active, editor tabs, and workflows). Treat that snapshot as authoritative. If no project is open, do not pretend you can read or write the book. Do not invent project facts.',
  )
}

/** Compose the settings identity the same way workflows and the old renderer builder did. */
export function renderAssistantIdentity(
  template: PromptTemplate,
  writingLanguage: WritingLanguage,
  modeInstruction: string,
): string {
  return `${composePromptSystemRole(template, writingLanguage)}\n\n${renderPrompt(
    template,
    { mode_instruction: modeInstruction },
    writingLanguage,
  )}`
}
