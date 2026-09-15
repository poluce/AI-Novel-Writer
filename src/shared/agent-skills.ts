/**
 * 助手 system prompt 里的 Skill 目录（渲染层 → 主进程 Pi Agent）。
 *
 * 系统提示词里只放「有哪些技能、各自适合什么任务」（Pi 的
 * `formatSkillsForSystemPrompt`），正文随目录一起送到主进程但不进提示词：
 * 助手需要时用 `load_writing_skill` 按名字取正文——这就是 Pi 的渐进式披露，
 * 用户输入 `/技能名` 时仍照旧把正文注入那一轮。
 */

/** Skill 来源，与 `skillRegistry` 的 `SkillSource` 同值。 */
export type AgentSkillSource = 'builtin' | 'user' | 'project'

export interface AgentSkillCatalogEntry {
  /** 稳定技能名，同时是用户侧的 `/名字` 命令。 */
  name: string
  /** 面向模型的简短描述（按项目写作语言取本地化文案）。 */
  description: string
  /** 技能文件位置；内置技能随包发布，没有可读文件，用 `builtin://名字` 占位。 */
  location: string
  /** 来源，仅用于主进程附加说明。 */
  source: AgentSkillSource
  /** 与 Pi `Skill.disableModelInvocation` 对齐：为真时不出现在模型可见清单里。 */
  disableModelInvocation?: boolean
  /**
   * 技能正文（按项目写作语言取好本地化文案）。只随 IPC 送到主进程，
   * 等模型调用 `load_writing_skill` 才进入上下文。
   */
  content?: string
}

/** 单条描述上限：SKILL.md 的 description 由用户提供，不能无限撑大 system prompt。 */
export const AGENT_SKILL_DESCRIPTION_MAX_CHARS = 300

/** 目录条数上限，避免异常目录结构把 system prompt 顶爆。 */
export const AGENT_SKILL_CATALOG_MAX_ENTRIES = 200

/** 单条技能正文上限：正文不进提示词，但也不该让一次 IPC 无限膨胀。 */
export const AGENT_SKILL_CONTENT_MAX_CHARS = 200_000

/** 主进程侧校验渲染层传入的目录，形状不符时按「没有技能」处理。 */
export function isAgentSkillCatalog(value: unknown): value is AgentSkillCatalogEntry[] {
  if (!Array.isArray(value) || value.length > AGENT_SKILL_CATALOG_MAX_ENTRIES) return false
  return value.every((entry) => {
    if (!entry || typeof entry !== 'object') return false
    const record = entry as Record<string, unknown>
    return typeof record.name === 'string'
      && record.name.length > 0
      && typeof record.description === 'string'
      && typeof record.location === 'string'
      && (record.source === 'builtin' || record.source === 'user' || record.source === 'project')
      && (record.disableModelInvocation === undefined || typeof record.disableModelInvocation === 'boolean')
      && (record.content === undefined
        || (typeof record.content === 'string' && record.content.length <= AGENT_SKILL_CONTENT_MAX_CHARS))
  })
}
