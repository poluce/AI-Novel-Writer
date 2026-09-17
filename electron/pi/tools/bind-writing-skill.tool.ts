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

const STAGE_ALIASES: Record<string, WritingSkillStage> = {
  planning: 'planning',
  drafting: 'drafting',
  review: 'review',
  refinement: 'refinement',
  '策划': 'planning',
  '大纲': 'planning',
  '起步': 'planning',
  '写稿': 'drafting',
  '草稿': 'drafting',
  '审稿': 'review',
  '评审': 'review',
  '修稿': 'refinement',
  '润色': 'refinement',
}

const Stage = Type.Union([
  Type.Literal('planning', { description: '策划/大纲阶段：用于故事构思、前提推演或大纲细化' }),
  Type.Literal('drafting', { description: '写稿阶段：用于章节正文创作' }),
  Type.Literal('review', { description: '审稿阶段：用于章节草稿挑刺审查与评估' }),
  Type.Literal('refinement', { description: '修稿阶段：用于依据审稿意见进行细节润色与重写' }),
], { description: '要绑定技能的写作流程阶段' })

const Schema = Type.Object({
  skill_id: Type.String({ description: '要绑定的写作技能唯一标识符（如 "review-chapter"）' }),
  stage: Stage,
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
      const rawStage = params.stage
      const stage = STAGE_ALIASES[rawStage] ?? (rawStage as WritingSkillStage)
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
