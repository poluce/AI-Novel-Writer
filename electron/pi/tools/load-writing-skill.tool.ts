import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { writingLanguageText, type WritingLanguage } from '../../../src/shared/writing-language'
import type { AgentSkillCatalogEntry } from '../../../src/shared/agent-skills'

const Schema = Type.Object({
  name: Type.String(),
})

/**
 * 渐进式披露的读取端：系统提示词里只有技能名与描述，正文等模型自己来取。
 *
 * 正文由渲染层的技能注册表随目录一起送来（内置技能没有文件，用户/项目技能
 * 在项目目录之外），所以这里不需要再碰文件系统，也不会越出既有的路径边界。
 */
export function createLoadWritingSkillTool(
  language: WritingLanguage,
  skills: readonly AgentSkillCatalogEntry[],
): AgentTool<typeof Schema> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const available = skills.filter(skill => skill.disableModelInvocation !== true)
  const byName = new Map(available.map(skill => [skill.name, skill]))

  return {
    name: 'load_writing_skill',
    label: 'Load Writing Skill',
    description: text(
      '读取某个写作技能的完整说明（SKILL.md 正文）。技能目录里只有名字与描述；当任务与某个技能的描述相符时，先用这个工具读出正文，再按正文执行。用户用 /技能名 显式调用时正文已经注入，不需要再读。',
      'Read the full instructions of one writing skill (its SKILL.md body). The skill listing only carries names and descriptions; when a task matches a skill description, load its body with this tool first and then follow it. When the user explicitly invokes /skill-name the body is already in context, so do not load it again.',
    ),
    parameters: Schema,
    execute: async (_id, params) => {
      const name = params.name?.trim()
      if (!name) throw new Error(text('缺少 name 参数', 'The name argument is required'))
      const skill = byName.get(name)
      if (!skill) {
        throw new Error(text(
          `没有名为“${name}”的技能。可用技能：${available.map(item => item.name).join('、') || '（无）'}`,
          `No skill named "${name}". Available skills: ${available.map(item => item.name).join(', ') || '(none)'}`,
        ))
      }
      const content = skill.content?.trim()
      if (!content) {
        throw new Error(text(
          `技能“${name}”没有可读正文。`,
          `Skill "${name}" has no readable body.`,
        ))
      }
      return {
        content: [{ type: 'text', text: content }],
        details: { name: skill.name, source: skill.source, location: skill.location },
      }
    },
  }
}
