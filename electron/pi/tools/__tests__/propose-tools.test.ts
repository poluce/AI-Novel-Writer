import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createProposeChapterBlueprintTool } from '../propose-chapter-blueprint.tool'

vi.mock('../../../repositories/project-core-repository', () => ({
  ProjectCoreRepository: { get: vi.fn(), update: vi.fn() },
}))
vi.mock('../../../repositories/blueprint-repository', () => ({
  BlueprintRepository: { getByChapter: vi.fn(), getAll: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
}))

import { ProjectCoreRepository } from '../../../repositories/project-core-repository'
import { BlueprintRepository } from '../../../repositories/blueprint-repository'

const coreGetMock = ProjectCoreRepository.get as ReturnType<typeof vi.fn>
const coreUpdateMock = ProjectCoreRepository.update as ReturnType<typeof vi.fn>
const bpGetMock = BlueprintRepository.getByChapter as ReturnType<typeof vi.fn>
const bpGetAllMock = BlueprintRepository.getAll as ReturnType<typeof vi.fn>
const bpUpsertMock = BlueprintRepository.upsert as ReturnType<typeof vi.fn>
const bpDeleteMock = BlueprintRepository.delete as ReturnType<typeof vi.fn>

beforeEach(() => {
  coreGetMock.mockReset()
  coreGetMock.mockReturnValue({ genre: '奇幻', totalChapters: 10, narrativePov: 'third_limited' })
  coreUpdateMock.mockReset()
  bpGetMock.mockReset()
  bpGetAllMock.mockReset()
  bpUpsertMock.mockReset()
  bpDeleteMock.mockReset()
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

  it('creates a new blueprint when it does not exist', async () => {
    bpGetMock.mockReturnValue(null)
    const tool = createProposeChapterBlueprintTool('zh-CN')
    const result = await tool.execute('c1', { chapter_number: 9, changes: { title: '新第九章' } })

    expect(bpUpsertMock).toHaveBeenCalledWith(expect.objectContaining({ chapterNumber: 9, title: '新第九章' }))
    expect(result.details.isNew).toBe(true)
  })

  it('supports partial snippet replacement via old_text and new_text', async () => {
    bpGetMock.mockReturnValue({
      chapterNumber: 2,
      title: '旧标题',
      keyEvents: '林舟调查密室，遭遇黑衣人袭击',
      characters: ['林舟'],
    })
    const tool = createProposeChapterBlueprintTool('zh-CN')
    const result = await tool.execute('c1', {
      chapter_number: 2,
      old_text: '遭遇黑衣人袭击',
      new_text: '发现暗格并取得关键密函',
    })

    expect(bpUpsertMock).toHaveBeenCalledWith(expect.objectContaining({
      chapterNumber: 2,
      keyEvents: '林舟调查密室，发现暗格并取得关键密函',
    }))
    expect((result.content[0] as { text: string }).text).toContain('第 2 章蓝图已成功更新')
  })

  it('supports batch multi-chapter creation', async () => {
    bpGetMock.mockReturnValue(null)
    const tool = createProposeChapterBlueprintTool('zh-CN')
    const result = await tool.execute('c1', {
      blueprints: [
        { chapter_number: 1, title: '第一章 启程', purpose: '铺垫世界观' },
        { chapter_number: 2, title: '第二章 初遇', purpose: '引出伙伴' },
      ],
    })

    expect(bpUpsertMock).toHaveBeenCalledTimes(2)
    expect(result.details.totalCount).toBe(2)
  })

  it('supports exporting full blueprints as complete markdown document', async () => {
    bpGetAllMock.mockReturnValue([
      { chapterNumber: 1, title: '第一章', role: '开端', purpose: '交代背景', keyEvents: '主角苏醒', characters: ['主角'] },
      { chapterNumber: 2, title: '第二章', role: '发展', purpose: '遭遇危机', keyEvents: '反派登场', characters: ['主角', '反派'] },
    ])
    const tool = createProposeChapterBlueprintTool('zh-CN')
    const result = await tool.execute('c1', { action: 'read' })

    const textOutput = (result.content[0] as { text: string }).text
    expect(textOutput).toContain('# 章节蓝图细纲文档（共 2 章）')
    expect(textOutput).toContain('主角苏醒')
    expect(textOutput).toContain('反派登场')
  })

  it('supports deleting a chapter blueprint', async () => {
    const tool = createProposeChapterBlueprintTool('zh-CN')
    const result = await tool.execute('c1', { action: 'delete', chapter_number: 3 })

    expect(bpDeleteMock).toHaveBeenCalledWith(3)
    expect(result.details.status).toBe('deleted')
  })
})
