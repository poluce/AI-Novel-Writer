import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()

vi.mock('../../ipc-client', () => ({ ipc: { invoke } }))
vi.mock('../../../stores/project-store', () => ({
  useProjectStore: { getState: () => ({ currentProject: null }) },
}))

describe('writing skill registry identity and command exposure', () => {
  beforeEach(() => invoke.mockReset())

  it('uses the catalog record name verbatim, so quoted frontmatter never leaks into ids', async () => {
    // 主进程用 Pi 的 YAML 解析器读出 `name: "quoted-skill"` → `quoted-skill`；
    // 渲染层只做映射，不再自己解析（YAML 解析的覆盖在主进程加载器用例里）。
    invoke.mockResolvedValue({
      skills: [{
        name: 'quoted-skill',
        description: 'Quoted metadata',
        content: 'Use concrete action.',
        baseDir: 'managed://skills/quoted-skill',
        filePath: 'managed://skills/quoted-skill/SKILL.md',
        source: 'user',
        language: 'zh-CN',
        stage: 'drafting',
        compatible: true,
        reasons: [],
        suggestedStage: 'drafting',
        utf8Bytes: 19,
      }],
      diagnostics: [],
    })

    const { skillRegistry } = await import('../skill-registry')
    await skillRegistry.loadAll()

    expect(skillRegistry.getById('user:quoted-skill')).toMatchObject({
      metadata: { name: 'quoted-skill', description: 'Quoted metadata' },
    })
    expect(skillRegistry.getById('user:"quoted-skill"')).toBeUndefined()
  })

  it('serializes atomic reloads without exposing a cleared or partial registry', async () => {
    const deferred = <T,>() => {
      let resolve!: (value: T) => void
      const promise = new Promise<T>(next => { resolve = next })
      return { promise, resolve }
    }
    const firstUserRead = deferred<unknown>()
    const secondUserRead = deferred<unknown>()
    const { parseSkillMd, skillRegistry } = await import('../skill-registry')
    const previous = parseSkillMd(
      '---\nname: previous-user-skill\ndescription: Previous\nstage: drafting\n---\nKeep prior content.',
      'previous-user-skill',
      'user',
      'managed://skills/previous-user-skill',
      'managed://skills/previous-user-skill/SKILL.md',
    )!
    skillRegistry.clear()
    skillRegistry.register(previous)
    invoke
      .mockReturnValueOnce(firstUserRead.promise)
      .mockReturnValueOnce(secondUserRead.promise)

    const firstLoad = skillRegistry.loadAll()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
    const secondLoad = skillRegistry.loadAll()

    expect(invoke).toHaveBeenCalledOnce()
    expect(skillRegistry.getById('user:previous-user-skill')).toBe(previous)

    firstUserRead.resolve({ skills: [], diagnostics: [] })
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
    secondUserRead.resolve({ skills: [], diagnostics: [] })
    await Promise.all([firstLoad, secondLoad])
    expect(skillRegistry.getById('builtin:long-form-continuity')).toBeDefined()
  })

  it('keeps same-named skills by stable id', async () => {
    invoke.mockResolvedValue({
      skills: [
        {
          name: 'writing-coach',
          description: 'User writing coach',
          content: 'Use concrete prose.',
          baseDir: 'managed://skills/writing-coach',
          filePath: 'managed://skills/writing-coach/SKILL.md',
          source: 'user',
          language: 'zh-CN',
          stage: 'refinement',
          compatible: true,
          reasons: [],
          suggestedStage: 'refinement',
          utf8Bytes: 19,
        },
        {
          name: 'scene-craft',
          description: 'Scene craft',
          content: 'Use concrete action.',
          baseDir: 'managed://skills/scene-craft',
          filePath: 'managed://skills/scene-craft/SKILL.md',
          source: 'user',
          language: 'zh-CN',
          stage: 'drafting',
          compatible: true,
          reasons: [],
          suggestedStage: 'drafting',
          utf8Bytes: 19,
        },
      ],
      diagnostics: [],
    })

    const { skillRegistry } = await import('../skill-registry')
    await skillRegistry.loadAll()

    expect(skillRegistry.getById('builtin:writing-coach')?.source).toBe('builtin')
    expect(skillRegistry.getById('user:writing-coach')?.source).toBe('user')
    expect(skillRegistry.get('writing-coach')?.source).toBe('builtin')
  })

  it('keeps every real built-in Skill letter-perfect in English and Chinese copy', async () => {
    invoke.mockResolvedValue({ skills: [], diagnostics: [] })
    const { skillRegistry } = await import('../skill-registry')
    await skillRegistry.loadAll()

    const builtins = skillRegistry.listBySource('builtin')
    expect(builtins.length).toBeGreaterThan(2)
    for (const skill of builtins) {
      const english = skill.localizedContent?.['en-US']
      expect(english, skill.metadata.name).toBeTruthy()
      expect(`${english}\n${skill.writingSkill.metadata.name}`, skill.metadata.name)
        .not.toMatch(/[\u3400-\u9fff]/u)
      // /命令 注入时用的是 localizedContent[语言] ?? content，两者都不能为空。
      expect(skill.content, skill.metadata.name).toBeTruthy()
      expect(skill.localizedContent?.['zh-CN'] ?? skill.content, skill.metadata.name).toBeTruthy()
    }
  })

})
