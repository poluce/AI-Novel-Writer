import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createProposeChapterBlueprintTool } from '../propose-chapter-blueprint.tool'

vi.mock('../../../repositories/project-core-repository', () => ({
  ProjectCoreRepository: { get: vi.fn(), update: vi.fn() },
}))
vi.mock('../../../repositories/blueprint-repository', () => ({
  BlueprintRepository: { getByChapter: vi.fn(), upsert: vi.fn() },
}))

import { ProjectCoreRepository } from '../../../repositories/project-core-repository'
import { BlueprintRepository } from '../../../repositories/blueprint-repository'

const coreGetMock = ProjectCoreRepository.get as ReturnType<typeof vi.fn>
const coreUpdateMock = ProjectCoreRepository.update as ReturnType<typeof vi.fn>
const bpGetMock = BlueprintRepository.getByChapter as ReturnType<typeof vi.fn>
const bpUpsertMock = BlueprintRepository.upsert as ReturnType<typeof vi.fn>

beforeEach(() => {
  coreGetMock.mockReset()
  coreGetMock.mockReturnValue({ genre: '奇幻', totalChapters: 10, narrativePov: 'third_limited' })
  coreUpdateMock.mockReset()
  bpGetMock.mockReset()
  bpUpsertMock.mockReset()
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
