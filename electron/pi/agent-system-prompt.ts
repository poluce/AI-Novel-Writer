import type { PromptTemplate } from '../../src/prompts/types'
import {
  ASSISTANT_WRITING_IDENTITY_KEY,
  appShellModeInstruction,
  renderAssistantIdentity,
} from '../../src/services/agent/assistant-identity'
import { getBuiltinPromptTemplate } from '../../src/services/prompt-templates'
import { localizeNovelConfigFacts } from '../../src/shared/novel-config-localization'
import { writingLanguageText, type WritingLanguage } from '../../src/shared/writing-language'
import type { ProjectCoreData } from '../repositories/project-core-repository'

/**
 * Main-process system prompt for the multi-turn Pi Agent.
 *
 * Identity comes from Settings `assistant_writing_identity` (caller supplies
 * the resolved overlay). L0 project facts come from SQLite. Tool instructions
 * stay on AgentTool schemas — they must not be pasted into the system string
 * as XML. Editor-tab L1 belongs on transformContext; it is intentionally
 * absent here.
 */
export function buildMainProcessAgentSystemPrompt(
  core: ProjectCoreData | null,
  identityTemplate?: PromptTemplate,
): string {
  const language: WritingLanguage = core?.writingLanguage ?? 'zh-CN'
  const template = identityTemplate
    ?? getBuiltinPromptTemplate(ASSISTANT_WRITING_IDENTITY_KEY, language)
  if (!template) throw new Error('Missing assistant writing identity prompt')
  const identity = renderAssistantIdentity(
    template,
    language,
    appShellModeInstruction(language),
  )
  const l0 = buildL0ProjectContext(core, language)
  return l0 ? `${identity}\n\n${l0}` : identity
}

function buildL0ProjectContext(core: ProjectCoreData | null, language: WritingLanguage): string | null {
  if (!core) return null
  const modelFacts = localizeNovelConfigFacts({
    genre: core.genre,
    targetAudience: core.targetAudience,
    plotStructure: core.plotStructure,
    narrativePOV: core.narrativePov,
  }, language)
  const label = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const parts: string[] = [
    `## ${label('当前项目上下文', 'Current project context')}`,
    `${label('项目名称', 'Project name')}: ${core.projectName}`,
  ]
  if (modelFacts.genre) {
    parts.push(`${label('类型', 'Genre')}: ${modelFacts.genre}${core.subGenre ? ` · ${core.subGenre}` : ''}`)
  }
  if (modelFacts.targetAudience) {
    parts.push(`${label('目标读者', 'Target readers')}: ${modelFacts.targetAudience}`)
  }
  if (core.totalChapters) {
    parts.push(`${label('计划章节数', 'Planned chapters')}: ${core.totalChapters}`)
  }
  if (core.wordsPerChapter) {
    parts.push(`${label('每章目标字数', 'Target words per chapter')}: ${core.wordsPerChapter}`)
  }
  if (modelFacts.narrativePOV) {
    parts.push(`${label('叙事视角', 'Point of view')}: ${modelFacts.narrativePOV}`)
  }
  if (core.coreOutline) {
    const outline = core.coreOutline.length > 300
      ? `${core.coreOutline.slice(0, 300)}${label('…', '...')}`
      : core.coreOutline
    parts.push(`${label('核心大纲', 'Core outline')}: ${outline}`)
  }
  if (core.writingStyle) {
    const style = core.writingStyle.length > 150
      ? `${core.writingStyle.slice(0, 150)}${label('…', '...')}`
      : core.writingStyle
    parts.push(`${label('写作风格', 'Writing style')}: ${style}`)
  }
  return parts.join('\n')
}
