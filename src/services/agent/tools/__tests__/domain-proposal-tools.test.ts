import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectStore } from '../../../../stores/project-store'
import { createAgentExecutionContext } from '../project-context'
import { proposeNovelConfigTool } from '../propose-novel-config.tool'
import {
  buildChapterBlueprintProposal,
  proposeChapterBlueprintTool,
} from '../propose-chapter-blueprint.tool'
import { builtinTools } from '..'
import { toolRegistry } from '../../tool-registry'

const invoke = vi.fn()
vi.mock('../../../ipc-client', () => ({
  ipc: { invokeWithProjectSession: (...args: unknown[]) => invoke(...args) },
}))

const project = {
  id: 'project-A', sessionLease: 'lease-A', name: 'A', path: 'C:\\novels\\A',
  novelConfig: {
    genre: '奇幻', subGenre: '', targetAudience: '青年', totalChapters: 10, wordsPerChapter: 3000,
    plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '旧大纲', worldSetting: '',
    goldenFinger: '', protagonistProfile: '', globalGuidance: '',
  },
  characterStates: '', createdAt: '', updatedAt: '',
}

const blueprint = {
  chapterNumber: 2, title: '旧标题', role: '发展', purpose: '推进调查', keyEvents: '找到线索',
  characters: ['林舟'], suspenseHook: '谁在说谎', userGuidance: '', notes: '', notesUpdatedAt: '',
}

beforeEach(() => {
  invoke.mockReset()
  useProjectStore.setState({ currentProject: project as never })
})

afterEach(() => {
  toolRegistry.unregister(proposeNovelConfigTool.name)
  toolRegistry.unregister(proposeChapterBlueprintTool.name)
  useProjectStore.setState({ currentProject: null })
})

describe('explicit Agent domain proposals', () => {
  it('exposes exactly the two explicit project-fact proposal tools', () => {
    const factMutationTools = builtinTools.filter(tool => (
      tool.name.includes('config') || tool.name.includes('blueprint')
    ) && !tool.isReadOnly)
    expect(factMutationTools.map(tool => tool.name)).toEqual([
      'propose_novel_config',
      'propose_chapter_blueprint',
    ])
  })

  it('commits an approved novel-config proposal through the existing project adapter', async () => {
    invoke.mockResolvedValue({ success: true })

    const result = await proposeNovelConfigTool.execute({ changes: { genre: '科幻', totalChapters: 12 } }, createAgentExecutionContext())

    expect(result).toMatchObject({ success: true })
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-A', leaseId: 'lease-A' }),
      'project:update-config', 'project-A',
      expect.objectContaining({ novelConfig: expect.objectContaining({ genre: '科幻', totalChapters: 12 }) }),
      project.path,
    )
  })

  it('accepts the narrativePov field emitted by read_project_state and stores the canonical config field', async () => {
    invoke.mockResolvedValue({ success: true })

    const result = await proposeNovelConfigTool.execute({
      changes: { narrativePov: 'first_person' },
    }, createAgentExecutionContext())

    expect(result).toMatchObject({ success: true })
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-A', leaseId: 'lease-A' }),
      'project:update-config', 'project-A',
      expect.objectContaining({ novelConfig: expect.objectContaining({ narrativePOV: 'first_person' }) }),
      project.path,
    )
  })

  it.each([
    ['简体中文', 'zh-CN'],
    ['English', 'en-US'],
  ])('normalizes the common language label %s before storing config', async (label, canonical) => {
    invoke.mockResolvedValue({ success: true })

    const result = await proposeNovelConfigTool.execute({
      changes: { writingLanguage: label },
    }, createAgentExecutionContext())

    expect(result).toMatchObject({ success: true })
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-A', leaseId: 'lease-A' }),
      'project:update-config', 'project-A',
      expect.objectContaining({ novelConfig: expect.objectContaining({ writingLanguage: canonical }) }),
      project.path,
    )
  })

  it('reports the received and allowed values for an unsupported config enum', async () => {
    const result = await proposeNovelConfigTool.execute({
      changes: { writingLanguage: 'Esperanto' },
    }, createAgentExecutionContext())

    expect(result).toMatchObject({ success: false })
    expect(result.error).toContain('Esperanto')
    expect(result.error).toContain('zh-CN')
    expect(result.error).toContain('en-US')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rejects unknown config fields without writing', async () => {
    const result = await proposeNovelConfigTool.execute({ changes: { apiKey: 'lure' } }, createAgentExecutionContext())
    expect(result).toMatchObject({ success: false })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('reports a failed config write without changing renderer facts', async () => {
    invoke.mockResolvedValue({ success: false, error: 'disk unavailable' })
    const result = await proposeNovelConfigTool.execute({ changes: { genre: '科幻' } }, createAgentExecutionContext())
    expect(result).toMatchObject({ success: false, error: 'disk unavailable' })
    expect(useProjectStore.getState().currentProject?.novelConfig.genre).toBe('奇幻')
  })

  it('merges an approved chapter-blueprint proposal into the existing target only', async () => {
    invoke
      .mockResolvedValueOnce(blueprint)
      .mockResolvedValueOnce({ success: true })

    const result = await proposeChapterBlueprintTool.execute({
      chapter_number: 2,
      changes: { title: '新标题', characters: ['林舟', '顾遥'] },
    }, createAgentExecutionContext())

    expect(result).toMatchObject({ success: true })
    expect(invoke).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ projectId: 'project-A', leaseId: 'lease-A' }),
      'db:blueprint-upsert',
      { ...blueprint, title: '新标题', characters: ['林舟', '顾遥'] },
      project.path,
    )
  })

  it.each(['作者微操指导', '用户指引'])(
    'normalizes the product blueprint field alias %s to userGuidance',
    async (field) => {
      const guidance = '加强第二章结尾的压迫感'
      const proposal = buildChapterBlueprintProposal({
        chapter_number: 2,
        changes: { [field]: guidance },
      }, blueprint)

      expect(proposal).toMatchObject({
        valid: true,
        changes: { userGuidance: guidance },
        diffs: [{ field: 'userGuidance', current: '', proposed: guidance }],
      })

      invoke
        .mockResolvedValueOnce(blueprint)
        .mockResolvedValueOnce({ success: true })
      const result = await proposeChapterBlueprintTool.execute({
        chapter_number: 2,
        changes: { [field]: guidance },
      }, createAgentExecutionContext())

      expect(proposeChapterBlueprintTool.requiresConfirmation).toBe(true)
      expect(result).toMatchObject({ success: true })
      expect(invoke).toHaveBeenNthCalledWith(2,
        expect.objectContaining({ projectId: 'project-A', leaseId: 'lease-A' }),
        'db:blueprint-upsert',
        { ...blueprint, userGuidance: guidance },
        project.path,
      )
    },
  )

  it('rejects missing targets, unknown fields, and stale sessions without writing', async () => {
    invoke.mockResolvedValue(null)
    const context = createAgentExecutionContext()
    await expect(proposeChapterBlueprintTool.execute({ chapter_number: 99, changes: { title: '不存在' } }, context))
      .resolves.toMatchObject({ success: false })
    expect(invoke).toHaveBeenCalledTimes(1)

    invoke.mockReset()
    await expect(proposeChapterBlueprintTool.execute({ chapter_number: 2, changes: { filePath: 'lure' } }, context))
      .resolves.toMatchObject({ success: false })
    expect(invoke).not.toHaveBeenCalled()

    useProjectStore.setState({ currentProject: { ...project, id: 'project-B', sessionLease: 'lease-B', path: 'C:\\novels\\B' } as never })
    await expect(proposeNovelConfigTool.execute({ changes: { genre: '悬疑' } }, context)).rejects.toThrow('项目已切换')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('does not upsert a blueprint when the project switches after the read', async () => {
    invoke.mockImplementationOnce(async () => {
      useProjectStore.setState({ currentProject: { ...project, id: 'project-B', sessionLease: 'lease-B', path: 'C:\\novels\\B' } as never })
      return blueprint
    })
    await expect(proposeChapterBlueprintTool.execute(
      { chapter_number: 2, changes: { title: '新标题' } },
      createAgentExecutionContext(),
    )).rejects.toThrow('项目已切换')
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
