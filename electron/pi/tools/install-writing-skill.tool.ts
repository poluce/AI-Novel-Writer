import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { installWritingSkill } from '../../services/writing-skill-service'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

const Schema = Type.Object({
  source_url: Type.String(),
})

export function createInstallWritingSkillTool(
  language: WritingLanguage,
): AgentTool<typeof Schema, { name: string }> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'After explicit user confirmation, re-inspect and install a self-contained prompt-only writing Skill from its public GitHub URL. A candidate must be inspected before installation. Scripts, tools, hooks, and subagents are rejected; this tool never executes code.'
    : '在用户确认后，从已给出的公开 GitHub 地址重新检查并安装自包含的提示词型 Skill。不能接收或执行脚本、工具、hook 或子代理。'

  return {
    name: 'install_writing_skill',
    label: 'Install Writing Skill',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const sourceUrl = params.source_url
      if (!sourceUrl || !sourceUrl.trim()) {
        throw new Error(text('缺少 source_url', 'The source_url argument is required'))
      }
      const result = await installWritingSkill(sourceUrl)
      if (!result.success) {
        throw new Error(result.error)
      }
      return {
        content: [{ type: 'text', text: text(
          `已安装写作 Skill“${result.skill.name}”。它尚未绑定到项目阶段。`,
          `Installed writing Skill "${result.skill.name}". It is not bound to a project stage yet.`,
        ) }],
        details: { name: result.skill.name },
      }
    },
  }
}
