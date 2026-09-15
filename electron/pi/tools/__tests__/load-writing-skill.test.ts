import { describe, expect, it } from 'vitest'

import type { AgentSkillCatalogEntry } from '../../../../src/shared/agent-skills'
import { createLoadWritingSkillTool } from '../load-writing-skill.tool'

const skills: AgentSkillCatalogEntry[] = [
  {
    name: 'scene-craft',
    description: '以有后果的选择推进场景。',
    location: 'managed://skills/scene-craft/SKILL.md',
    source: 'user',
    content: '每个场景围绕一次有代价的选择展开。',
  },
  {
    name: 'hidden',
    description: '不对外暴露的技能。',
    location: 'managed://skills/hidden/SKILL.md',
    source: 'user',
    disableModelInvocation: true,
    content: '不该被模型读到。',
  },
]

describe('load_writing_skill', () => {
  it('returns the skill body by name', async () => {
    const tool = createLoadWritingSkillTool('zh-CN', skills)
    const result = await tool.execute('c1', { name: 'scene-craft' })
    const first = result.content[0]
    expect(first.type).toBe('text')
    if (first.type === 'text') expect(first.text).toContain('有代价的选择')
    expect(result.details).toMatchObject({ name: 'scene-craft', source: 'user' })
  })

  it('trims the name and rejects an unknown skill with the available list', async () => {
    const tool = createLoadWritingSkillTool('zh-CN', skills)
    await expect(tool.execute('c1', { name: 'nope' })).rejects.toThrow(/没有名为“nope”的技能/)
  })

  it('never serves a skill the model may not invoke', async () => {
    const tool = createLoadWritingSkillTool('zh-CN', skills)
    await expect(tool.execute('c1', { name: 'hidden' })).rejects.toThrow(/没有名为“hidden”的技能/)
  })

  it('reports a skill without a readable body instead of returning nothing', async () => {
    const tool = createLoadWritingSkillTool('en-US', [{
      name: 'empty',
      description: 'Empty skill',
      location: 'builtin://empty',
      source: 'builtin',
    }])
    await expect(tool.execute('c1', { name: 'empty' })).rejects.toThrow(/no readable body/)
  })
})
