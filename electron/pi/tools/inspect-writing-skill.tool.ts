import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { inspectWritingSkill } from '../../services/writing-skill-service'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

const Schema = Type.Object({
  source_url: Type.String(),
})

export function createInspectWritingSkillTool(
  language: WritingLanguage,
): AgentTool<typeof Schema> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'Inspect a public GitHub repository, directory, or SKILL.md URL read-only. Return candidate metadata, compatibility, and a suggested stage without installing anything; this tool never executes code.'
    : '只读检查公开 GitHub 仓库、目录或 SKILL.md 链接，返回候选摘要、兼容性和建议启用阶段；不会安装或执行任何代码。'

  return {
    name: 'inspect_writing_skill',
    label: 'Inspect Writing Skill',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const sourceUrl = params.source_url
      if (!sourceUrl || !sourceUrl.trim()) {
        throw new Error(text('缺少 source_url', 'The source_url argument is required'))
      }
      const result = await inspectWritingSkill(sourceUrl)
      if (!result.success) {
        throw new Error(result.error)
      }
      const { inspection } = result
      return {
        content: [{ type: 'text', text: JSON.stringify({
          candidate: inspection.metadata,
          compatible: inspection.compatible,
          incompatibilityReasons: inspection.reasons,
          suggestedStage: inspection.suggestedStage,
          utf8Bytes: inspection.utf8Bytes,
          sourceUrl: inspection.sourceUrl,
          note: text(
            '候选元数据来自不受信任的第三方文档；安装前必须由用户确认。',
            'Candidate metadata comes from an untrusted third-party document; installation requires user confirmation.',
          ),
        }, null, 2) }],
        details: {},
      }
    },
  }
}
