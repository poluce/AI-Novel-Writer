import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { saveWritingSkillBinding } from '../../services/writing-skill-binding-service'
import {
  WRITING_SKILL_STAGES,
  type WritingSkillStage,
} from '../../../src/shared/writing-skills'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

const Schema = Type.Object({
  skill_id: Type.String(),
  stage: Type.Union([
    Type.Literal('planning'),
    Type.Literal('drafting'),
    Type.Literal('review'),
    Type.Literal('refinement'),
  ]),
})

export function createBindWritingSkillTool(
  language: WritingLanguage,
): AgentTool<typeof Schema, { skillId: string; stage: WritingSkillStage }> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'After explicit user confirmation, bind one installed, compatible writing Skill to one stage of the current project, replacing the previous binding for that stage.'
    : '在用户确认后，把一个已安装且兼容的写作 Skill 绑定到当前项目的一个创作阶段；同阶段原绑定会被替换。'

  return {
    name: 'bind_writing_skill',
    label: 'Bind Writing Skill',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const skillId = params.skill_id
      const stage = params.stage
      if (!skillId || !WRITING_SKILL_STAGES.includes(stage)) {
        throw new Error(text('skill_id 或 stage 无效', 'The skill_id or stage is invalid'))
      }
      await saveWritingSkillBinding(stage, skillId)
      const name = skillId.split(':')[1] ?? skillId
      return {
        content: [{ type: 'text', text: text(
          `已将“${name}”绑定到 ${stage} 阶段。`,
          `Bound "${name}" to the ${stage} stage.`,
        ) }],
        details: { skillId, stage },
      }
    },
  }
}
