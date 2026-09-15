import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../ipc-client', () => ({ ipc: { invoke: vi.fn() } }))
vi.mock('../../../stores/project-store', () => ({
  useProjectStore: { getState: () => ({ currentProject: null }) },
}))

import { parseSkillMd, skillRegistry } from '../skill-registry'
import {
  buildAgentSkillCatalog,
  skillDescription,
  skillDisplayName,
  toAgentSkillCatalog,
} from '../skill-catalog'
import { AGENT_SKILL_DESCRIPTION_MAX_CHARS } from '../../../shared/agent-skills'

afterEach(() => skillRegistry.clear())

function userSkill(name = 'scene-craft') {
  const skill = parseSkillMd(
    `---\nname: ${name}\ndisplay_name: Scene Craft\ndescription: Build scenes around consequential choices.\nstage: drafting\n---\nUse concrete action.`,
    name,
    'user',
    `managed://skills/${name}`,
    `managed://skills/${name}/SKILL.md`,
  )!
  skill.metadata.displayName = '场景塑造'
  skill.metadata.description = '以有后果的选择推进场景。'
  return skill
}

describe('agent skill catalog', () => {
  it('maps loaded skills to the model-visible catalog with localized copy', () => {
    skillRegistry.register(userSkill())

    expect(toAgentSkillCatalog(skillRegistry.listAll(), 'zh-CN')).toEqual([
      {
        name: 'scene-craft',
        description: '以有后果的选择推进场景。',
        location: 'managed://skills/scene-craft/SKILL.md',
        source: 'user',
        disableModelInvocation: undefined,
        // 正文随目录下发但不进提示词：模型要靠 load_writing_skill 按需取。
        content: 'Use concrete action.',
      },
    ])
    expect(toAgentSkillCatalog(skillRegistry.listAll(), 'en-US')[0].description)
      .toBe('Build scenes around consequential choices.')
  })

  it('keeps built-in skills in the catalog using their bundled location', async () => {
    await skillRegistry.loadAll()
    const catalog = buildAgentSkillCatalog('zh-CN')
    const review = catalog.find(item => item.name === 'review-chapter')
    expect(review).toBeDefined()
    expect(review?.source).toBe('builtin')
    expect(review?.location).toBe('builtin://review-chapter')
    expect(review?.description).toBeTruthy()
  })

  it('hides skills the user may not invoke from the model list', () => {
    const skill = userSkill()
    skill.metadata.userInvocable = false
    skillRegistry.register(skill)
    expect(buildAgentSkillCatalog('zh-CN')[0].disableModelInvocation).toBe(true)
  })

  it('clamps descriptions and caps the catalog so it cannot bloat the prompt', () => {
    const skill = userSkill()
    skill.metadata.description = 'x'.repeat(AGENT_SKILL_DESCRIPTION_MAX_CHARS + 50)
    const [clamped] = toAgentSkillCatalog([skill], 'zh-CN')
    expect(clamped.description).toHaveLength(AGENT_SKILL_DESCRIPTION_MAX_CHARS)
    expect(clamped.description.endsWith('…')).toBe(true)

    const many = Array.from({ length: 300 }, (_, index) => userSkill(`skill-${index}`))
    const capped = toAgentSkillCatalog(many, 'zh-CN')
    expect(capped).toHaveLength(200)
    expect(capped.at(-1)?.name).toBe('skill-199')
  })

  it('waits for an in-flight load instead of reading an empty registry', async () => {
    const invoke = vi.mocked((await import('../../ipc-client')).ipc.invoke)
    invoke.mockResolvedValue([{
      name: 'scene-craft',
      baseDir: 'managed://skills/scene-craft',
      filePath: 'managed://skills/scene-craft/SKILL.md',
      content: '---\nname: scene-craft\ndescription: 场景塑造\nstage: drafting\n---\n正文',
    }])
    invoke.mockClear()
    void skillRegistry.loadAll()

    await skillRegistry.ensureLoaded()

    expect(buildAgentSkillCatalog('zh-CN').map(item => item.name)).toContain('scene-craft')
    // 已经在加载的那一次就够用，不重复读盘。
    expect(invoke.mock.calls.filter(([channel]) => channel === 'skills:list-user')).toHaveLength(1)
  })

  it('returns immediately once skills are loaded', async () => {
    const invoke = vi.mocked((await import('../../ipc-client')).ipc.invoke)
    invoke.mockResolvedValue([])
    invoke.mockClear()
    await skillRegistry.loadAll()
    const callsAfterLoad = invoke.mock.calls.length

    await skillRegistry.ensureLoaded()

    expect(invoke.mock.calls).toHaveLength(callsAfterLoad)
  })

  it('shares one display-name and description rule with the skill list UI', () => {
    const skill = userSkill()
    expect(skillDisplayName(skill, 'zh-CN')).toBe('场景塑造')
    expect(skillDisplayName(skill, 'en-US')).toBe('Scene Craft')
    expect(skillDescription(skill, 'zh-CN')).toBe('以有后果的选择推进场景。')
    expect(skillDescription(skill, 'en-US')).toBe('Build scenes around consequential choices.')
  })
})
