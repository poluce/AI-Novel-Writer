import { writingLanguageText, type WritingLanguage } from '../shared/writing-language'
import { internalPrompt } from '../prompts/internal/load'

/** 内置提示词正文与结构已外置到 src/prompts/；这里只转发，保持既有导入路径。 */
export { EN_US_BUILTIN_PROMPTS } from '../prompts/load'
export {
  CORE_LOCALIZED_BUILTIN_PROMPT_KEYS,
  isCoreLocalizedBuiltinPromptKey,
} from '../prompts/manifest'
export type { CoreLocalizedBuiltinPromptKey } from '../prompts/manifest'

export interface CharacterArchitecturePromptSet {
  manifestSystem: string
  detailSystem: string
  detailContract: string
  manifestTask(context: string, minimum: number, maximum: number): string
  detailTask(input: {
    context: string
    manifest: string
    slotIds: string
    validatedPrefix: string
  }): string
}

/**
 * Built-in templates used by the forward-writing lifecycle. Every key in this
 * list must provide an English overlay; commands may not silently fall back to
 * the historical Chinese template for an English project.
 */
const CHARACTER_ARCHITECTURE_PROMPTS: Readonly<Record<WritingLanguage, CharacterArchitecturePromptSet>> = {
  'zh-CN': buildCharacterArchitecturePrompts('zh-CN'),
  'en-US': buildCharacterArchitecturePrompts('en-US'),
}

/**
 * 提示词正文在 `src/prompts/internal/<language>/*.md`；这里只负责把变量喂给模板。
 * `detail_contract` 复用同一语言的合同文本，避免中英两处各写一遍。
 */
function buildCharacterArchitecturePrompts(language: WritingLanguage): CharacterArchitecturePromptSet {
  const detailContract = internalPrompt('character_architecture_detail_contract', language)
  return {
    manifestSystem: internalPrompt('character_architecture_manifest_system', language),
    detailSystem: internalPrompt('character_architecture_detail_system', language),
    detailContract,
    manifestTask: (context, minimum, maximum) => internalPrompt(
      'character_architecture_manifest_task',
      language,
      { context, minimum, maximum },
    ),
    detailTask: input => internalPrompt('character_architecture_detail_task', language, {
      context: input.context,
      detail_contract: detailContract,
      manifest: input.manifest,
      slot_ids: input.slotIds,
      validated_prefix: input.validatedPrefix,
    }),
  }
}

export function characterArchitecturePrompts(language: WritingLanguage): CharacterArchitecturePromptSet {
  return CHARACTER_ARCHITECTURE_PROMPTS[language]
}

/**
 * Model-facing built-in prompt translations. UI copy is deliberately absent:
 * the project writing language, not the application locale, selects this map.
 */
export function promptLanguageText(
  language: WritingLanguage,
  zhCNText: string,
  enUSText: string,
): string {
  return writingLanguageText(language, zhCNText, enUSText)
}
