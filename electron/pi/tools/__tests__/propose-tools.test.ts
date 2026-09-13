import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createProposeNovelConfigTool } from '../propose-novel-config.tool'
import { createProposeChapterBlueprintTool } from '../propose-chapter-blueprint.tool'
import type { RendererAction } from '../../renderer-action'

vi.mock('../../../repositories/project-core-repository', () => ({
  ProjectCoreRepository: { update: vi.fn() },
}))
vi.mock('../../../repositories/blueprint-repository', () => ({
  BlueprintRepository: { getByChapter: vi.fn(), upsert: vi.fn() },
}))

import { ProjectCoreRepository } from '../../../repositories/project-core-repository'
import { BlueprintRepository } from '../../../repositories/blueprint-repository'

const coreUpdateMock = ProjectCoreRepository.update as ReturnType<typeof vi.fn>
const bpGetMock = BlueprintRepository.getByChapter as ReturnType<typeof vi.fn>
const bpUpsertMock = BlueprintRepository.upsert as ReturnType<typeof vi.fn>

beforeEach(() => {
  coreUpdateMock.mockReset()
  bpGetMock.mockReset()
  bpUpsertMock.mockReset()
})

describe('propose_novel_config', () => {
  it('writes the config and emits a refresh action', async () => {
    coreUpdateMock.mockReturnValue(undefined)
    const actions: RendererAction[] = []
    const tool = createProposeNovelConfigTool('zh-CN', (a) => { actions.push(a) })
    const result = await tool.execute('c1', { changes: { genre: 'fantasy', totalChapters: 10 } })

    expect(coreUpdateMock).toHaveBeenCalled()
    expect(actions).toHaveLength(1)
    expect(actions[0]).toEqual({ type: 'refresh_project_config' })
    expect(result.details.fields).toBe(2)
  })

  it('rejects an unknown field', async () => {
    const tool = createProposeNovelConfigTool('zh-CN', () => {})
    await expect(tool.execute('c1', { changes: { bogus: 'x' } })).rejects.toThrow('未知小说配置字段')
  })
})

describe('propose_chapter_blueprint', () => {
  it('reads the current blueprint and upserts the merged result', async () => {
    bpGetMock.mockReturnValue({ chapterNumber: 1, title: '旧标题', characters: [] })
    bpUpsertMock.mockReturnValue(undefined)
    const tool = createProposeChapterBlueprintTool('zh-CN')
    const result = await tool.execute('c1', { chapter_number: 1, changes: { title: '新标题' } })

    expect(bpUpsertMock).toHaveBeenCalledWith(expect.objectContaining({ chapterNumber: 1, title: '新标题' }))
    expect(result.details.fields).toBe(1)
  })

  it('throws when the blueprint does not exist', async () => {
    bpGetMock.mockReturnValue(null)
    const tool = createProposeChapterBlueprintTool('zh-CN')
    await expect(tool.execute('c1', { chapter_number: 9, changes: { title: 'x' } })).rejects.toThrow('蓝图不存在')
  })
})
