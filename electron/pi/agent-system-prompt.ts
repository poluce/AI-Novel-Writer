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
  if (core.goldenFinger) {
    parts.push(`${label('金手指', 'Golden finger')}: ${core.goldenFinger}`)
  }
  if (core.worldSetting) {
    parts.push(`${label('世界观设定', 'World setting')}: ${core.worldSetting}`)
  }
  if (core.protagonistProfile) {
    parts.push(`${label('主角人设', 'Protagonist profile')}: ${core.protagonistProfile}`)
  }
  if (core.writingStyle) {
    parts.push(`${label('写作风格', 'Writing style')}: ${core.writingStyle}`)
  }
  parts.push('')
  parts.push(writingLanguageText(
    language,
    [
      '### 创作协同与直接填充规则：',
      '- 写前先读原则（Read Before Write）：当作者要求对已有设定、大纲或架构进行修改、微调或润色时，必须先使用对应工具的读取操作（action: "read"）读取当前已有内容，在已有事实基础上增补修改，严禁盲目覆盖或丢失作者已有内容。',
      '- 局部精准替换模式（Targeted Excerpt Replacement）：当大纲或长篇设定只需修改其中一段时，使用工具的 `old_text` 与 `new_text` 参数进行局部替换，避免将数千字长文本全量重写回传，确保未受影响的大纲内容完好无损。',
      '- 章节正文修改与润色（Draft Modification）：当作者要求对某一章的正文草稿进行修改或润色时，必须先使用 `read_drafts` 工具读取该章最新正文，提取精确无误的原文片段作为 `old_text`，再调用 `replace_draft_excerpt` 进行替换，严禁凭记忆猜测原文。',
      '- 当与作者探讨小说设定（基本信息、核心大纲、世界观、金手指、主角人设、创作指导等）时，请在对话中给出内容并调用 `novel_config` 工具直接填充或修改指定字段。',
      '- 当与作者探讨故事架构（故事前提 premise、世界观 worldbuilding、情节大纲 synopsis）时，请在对话中给出内容并调用 `story_architecture` 工具直接填充或修改对应架构文档。',
      '- 当与作者探讨小说人物（角色档案、人际关系网、境界身心状态、出场轨迹等）时，请使用 `manage_characters` 工具进行全方位查询、回溯指定章节历史状态、建档、局部微调、状态推进或级联改名。',
    ].join('\n'),
    [
      '### Creative Collaboration & Direct Fill Rules:',
      '- Read Before Write Principle: When the author asks to modify, refine, or adjust existing settings or outlines, always inspect current content first via action: "read" before updating, preserving established author facts and avoiding blind overwrites.',
      '- Targeted Excerpt Replacement: When modifying only one paragraph or scene within a long outline or setting, provide `old_text` and `new_text` to replace that excerpt precisely instead of rewriting thousands of words.',
      '- Chapter Draft Modification: When modifying or polishing a chapter draft, always call `read_drafts` first to read the current text, extract the exact original prose as `old_text`, and then call `replace_draft_excerpt`. Never guess or hallucinate original text.',
      '- When discussing novel settings (basic info, core outline, world setting, golden finger, protagonist profile, guidance, etc.), collaborate in chat and call the `novel_config` tool to directly read or fill/update the designated field.',
      '- When discussing story architecture (premise, worldbuilding, synopsis), collaborate in chat and call the `story_architecture` tool to directly read or fill/update the designated architecture document.',
      '- When discussing characters (profiles, relationships, power/physical states, chapter appearances, etc.), call the `manage_characters` tool to query, review chapter history, create, partially update, advance states, or cascade renames.',
    ].join('\n'),
  ))
  return parts.join('\n')
}
