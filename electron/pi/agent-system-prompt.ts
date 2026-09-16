import { formatSkillsForSystemPrompt, type Skill } from '@earendil-works/pi-agent-core'

import type { PromptTemplate } from '../../src/prompts/types'
import {
  ASSISTANT_WRITING_IDENTITY_KEY,
  appShellModeInstruction,
  renderAssistantIdentity,
} from '../../src/services/agent/assistant-identity'
import { getBuiltinPromptTemplate } from '../../src/services/prompt-templates'
import {
  AGENT_SKILL_DESCRIPTION_MAX_CHARS,
  type AgentSkillCatalogEntry,
} from '../../src/shared/agent-skills'
import type { AgentScope } from '../../src/shared/agent-scope'
import { localizeNovelConfigFacts } from '../../src/shared/novel-config-localization'
import { writingLanguageText, type WritingLanguage } from '../../src/shared/writing-language'
import type { ProjectCoreData } from '../repositories/project-core-repository'

/**
 * Main-process system prompt for the multi-turn Pi Agent.
 *
 * Identity comes from Settings `assistant_writing_identity` (caller supplies
 * the resolved overlay). L0 project facts come from SQLite. The skill catalog
 * is rendered by Pi's own `formatSkillsForSystemPrompt`. Tool instructions
 * stay on AgentTool schemas — they must not be pasted into the system string
 * as XML. Editor-tab L1 belongs on transformContext; it is intentionally
 * absent here.
 */
export function buildMainProcessAgentSystemPrompt(
  core: ProjectCoreData | null,
  identityTemplate?: PromptTemplate,
  skills?: readonly AgentSkillCatalogEntry[],
  scope: AgentScope = 'project',
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
  const skillCatalog = buildSkillCatalogBlock(skills, language, scope)
  return [identity, l0, skillCatalog].filter((part): part is string => Boolean(part)).join('\n\n')
}

/**
 * Pi's own skill listing (name / description / location) plus the two facts
 * Pi cannot know: in this app skills are not read by the assistant, they take
 * effect through `/技能名` and workflow stage bindings only.
 */
function buildSkillCatalogBlock(
  skills: readonly AgentSkillCatalogEntry[] | undefined,
  language: WritingLanguage,
  scope: AgentScope,
): string | null {
  if (!skills || skills.length === 0) return null
  const block = formatSkillsForSystemPrompt(skills.map(toPiSkill))
  if (!block) return null
  return `${block}\n\n${skillInvocationNote(language, scope)}`
}

function toPiSkill(entry: AgentSkillCatalogEntry): Skill {
  return {
    name: entry.name,
    description: entry.description.slice(0, AGENT_SKILL_DESCRIPTION_MAX_CHARS),
    // Pi only reads `content` for explicit invocation; this listing never
    // carries skill bodies into the system prompt.
    content: '',
    filePath: entry.location,
    disableModelInvocation: entry.disableModelInvocation,
  }
}

function skillInvocationNote(language: WritingLanguage, scope: AgentScope): string {
  // 没有项目时不存在工作流阶段绑定，说明里不能提它。
  const projectOnly = scope === 'project'
  return writingLanguageText(
    language,
    [
      '技能说明按需读取，不要凭描述猜内容：',
      '- 目录里只有技能名与描述。当任务与某个技能的描述相符时，先用 load_writing_skill 读出正文，再按正文执行。',
      projectOnly
        ? '- 用户在输入框输入 `/技能名` 时，正文已经注入到那一轮消息，不需要再读；写作工作流也可以在某个阶段绑定技能。'
        : '- 用户在输入框输入 `/技能名` 时，正文已经注入到那一轮消息，不需要再读。',
      '- 不要用 read_file 去读技能文件：用户级技能在项目目录之外，会被拒绝。',
      '- 当任务与某个技能的描述相符时，也可以直接用 `/技能名` 建议用户启用它。',
    ].join('\n'),
    [
      'Read skill instructions on demand instead of guessing from a description:',
      '- The listing carries only names and descriptions. When a task matches a skill description, load its body with load_writing_skill first and then follow it.',
      projectOnly
        ? '- When the user types `/skill-name`, that skill body is already injected into that turn and does not need loading; a writing workflow can also bind a skill to one of its stages.'
        : '- When the user types `/skill-name`, that skill body is already injected into that turn and does not need loading.',
      '- Do not read skill files with read_file: user-level skills live outside the project directory and such reads are rejected.',
      '- When a task matches a skill description, you may also suggest the user enable it with `/skill-name`.',
    ].join('\n'),
  )
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
    parts.push(`${label('核心大纲', 'Core outline')}: ${core.coreOutline}`)
  }
  if (core.writingStyle) {
    parts.push(`${label('写作风格', 'Writing style')}: ${core.writingStyle}`)
  }
  return parts.join('\n')
}
