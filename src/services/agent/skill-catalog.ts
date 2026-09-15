/**
 * Skill 目录构造：把 `skillRegistry` 里已加载的技能压成主进程可用的
 * 模型可见清单（见 `src/shared/agent-skills.ts`）。
 *
 * 名称/描述按项目写作语言取本地化文案，规则与 UI 侧技能列表一致：
 * 内置技能的英文文案在 `writingSkill`（`SKILL.md` frontmatter）里，
 * 中文文案在 `metadata` 里；用户/项目技能的两者相同。
 */

import { skillRegistry, type LoadedSkill } from './skill-registry'
import {
  AGENT_SKILL_CATALOG_MAX_ENTRIES,
  AGENT_SKILL_DESCRIPTION_MAX_CHARS,
  type AgentSkillCatalogEntry,
} from '../../shared/agent-skills'

/** 技能显示名（中文取 `metadata`，英文取 `writingSkill`），与技能列表一致。 */
export function skillDisplayName(skill: LoadedSkill, locale: 'zh-CN' | 'en-US'): string {
  return locale === 'en-US'
    ? (skill.writingSkill.metadata.displayName ?? skill.metadata.name)
    : (skill.metadata.displayName ?? skill.metadata.name)
}

/** 技能描述（中文取 `metadata`，英文取 `writingSkill`），与技能列表一致。 */
export function skillDescription(skill: LoadedSkill, locale: 'zh-CN' | 'en-US'): string {
  return locale === 'en-US'
    ? skill.writingSkill.metadata.description
    : skill.metadata.description
}

function clampDescription(description: string): string {
  const trimmed = description.trim()
  if (trimmed.length <= AGENT_SKILL_DESCRIPTION_MAX_CHARS) return trimmed
  return `${trimmed.slice(0, AGENT_SKILL_DESCRIPTION_MAX_CHARS - 1)}…`
}

/** 把已加载技能压成模型可见目录；顺序与技能列表相同。 */
export function toAgentSkillCatalog(
  skills: readonly LoadedSkill[],
  locale: 'zh-CN' | 'en-US',
): AgentSkillCatalogEntry[] {
  return skills.slice(0, AGENT_SKILL_CATALOG_MAX_ENTRIES).map(skill => ({
    name: skill.metadata.name,
    description: clampDescription(skillDescription(skill, locale)) || skill.metadata.name,
    location: skill.filePath,
    source: skill.source,
    // 正文随目录下发但只留在主进程内存里：模型调用 `load_writing_skill` 才看得到。
    ...(skill.localizedContent?.[locale] ?? skill.content
      ? { content: skill.localizedContent?.[locale] ?? skill.content }
      : {}),
    // 与 `getAllSlashCommands` 同一门控：`userInvocable === false` 的技能
    // 仍然存在，但不进入模型可见清单。
    disableModelInvocation: skill.metadata.userInvocable === false ? true : undefined,
  }))
}

/** 当前注册中心的模型可见技能目录。 */
export function buildAgentSkillCatalog(locale: 'zh-CN' | 'en-US'): AgentSkillCatalogEntry[] {
  return toAgentSkillCatalog(skillRegistry.listAll(), locale)
}
