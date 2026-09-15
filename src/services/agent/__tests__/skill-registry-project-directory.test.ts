import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  invokeWithProjectSession: vi.fn(),
}))

const currentProject = {
  id: 'project-1',
  path: 'C:/novels/project-1',
  sessionLease: 'lease-1',
}

vi.mock('../../ipc-client', () => ({
  ipc: {
    invoke: mocks.invoke,
    invokeWithProjectSession: mocks.invokeWithProjectSession,
    isElectron: true,
  },
}))

vi.mock('../../../stores/project-store', () => ({
  useProjectStore: { getState: () => ({ currentProject }) },
}))

/** 主进程目录接口的返回形状。 */
function catalog(overrides: Partial<{ skills: unknown[]; diagnostics: unknown[] }> = {}) {
  return { skills: [], diagnostics: [], ...overrides }
}

describe('project skill catalog loading', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.invoke.mockResolvedValue(catalog())
    mocks.invokeWithProjectSession.mockReset()
    mocks.invokeWithProjectSession.mockResolvedValue(catalog())
  })

  it('asks the main process for the catalog with the frozen project session', async () => {
    const { skillRegistry } = await import('../skill-registry')
    await expect(skillRegistry.loadAll()).resolves.toBeUndefined()

    // 目录扫描（含项目内的 .vela/skills）只在主进程做，渲染层不再自己翻目录。
    expect(mocks.invokeWithProjectSession).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-1', leaseId: 'lease-1' }),
      'skills:load-catalog',
      currentProject.path,
    )
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('keeps built-in skills when the project catalog is unavailable', async () => {
    const denied = new Error(
      "Error invoking remote method 'skills:load-catalog': Error: 项目上下文已切换，已拒绝跨项目读写",
    )
    mocks.invokeWithProjectSession.mockRejectedValue(denied)

    const { skillRegistry } = await import('../skill-registry')
    await expect(skillRegistry.loadAll()).resolves.toBeUndefined()

    // 项目技能读不到不该让整个注册表空掉：内置技能仍在，诊断可查。
    expect(skillRegistry.getById('builtin:long-form-continuity')).toBeDefined()
    expect(skillRegistry.listDiagnostics()).toEqual([
      expect.objectContaining({ code: 'list_failed' }),
    ])
  })

  it('loads project skills from the catalog and tags them with the project lease', async () => {
    mocks.invokeWithProjectSession.mockResolvedValue(catalog({
      skills: [{
        name: 'scene-craft',
        description: '场景塑造',
        content: '每个场景围绕一次有代价的选择展开。',
        filePath: 'C:/novels/project-1/.vela/skills/scene-craft/SKILL.md',
        baseDir: 'C:/novels/project-1/.vela/skills/scene-craft',
        source: 'project',
        language: 'zh-CN',
        compatible: true,
        reasons: [],
        suggestedStage: 'drafting',
        utf8Bytes: 42,
      }],
    }))

    const { skillRegistry } = await import('../skill-registry')
    await skillRegistry.loadAll()

    expect(skillRegistry.getById('project:scene-craft')).toMatchObject({
      source: 'project',
      content: '每个场景围绕一次有代价的选择展开。',
      projectSession: expect.objectContaining({ leaseId: 'lease-1' }),
      metadata: { name: 'scene-craft', description: '场景塑造' },
    })
  })

  it('surfaces spec diagnostics instead of silently dropping a skill', async () => {
    mocks.invokeWithProjectSession.mockResolvedValue(catalog({
      diagnostics: [{
        code: 'invalid_metadata',
        message: 'name "SceneCraft" does not match parent directory "scene-craft"',
        path: 'C:/novels/project-1/.vela/skills/scene-craft/SKILL.md',
        source: 'project',
      }],
    }))

    const { skillRegistry } = await import('../skill-registry')
    await skillRegistry.loadAll()

    expect(skillRegistry.listDiagnostics()).toEqual([
      expect.objectContaining({ code: 'invalid_metadata', source: 'project' }),
    ])
  })

  it('clears diagnostics together with the registry', async () => {
    mocks.invokeWithProjectSession.mockResolvedValue(catalog({
      diagnostics: [{ code: 'invalid_metadata', message: 'x', path: 'y' }],
    }))

    const { skillRegistry } = await import('../skill-registry')
    await skillRegistry.loadAll()
    expect(skillRegistry.listDiagnostics()).toHaveLength(1)

    skillRegistry.clear()
    expect(skillRegistry.listDiagnostics()).toEqual([])
  })
})
