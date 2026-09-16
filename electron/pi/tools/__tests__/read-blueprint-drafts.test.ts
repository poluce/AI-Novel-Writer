import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createReadBlueprintTool } from '../read-blueprint.tool'
import { createReadDraftsTool } from '../read-drafts.tool'

vi.mock('../../../repositories/blueprint-repository', () => ({
  BlueprintRepository: { getAll: vi.fn(), getByChapter: vi.fn() },
}))
vi.mock('../../../repositories/draft-repository', () => ({
  DraftRepository: { listByChapter: vi.fn(), getFull: vi.fn() },
}))

import { BlueprintRepository } from '../../../repositories/blueprint-repository'
import { DraftRepository } from '../../../repositories/draft-repository'

const bpGetAllMock = BlueprintRepository.getAll as ReturnType<typeof vi.fn>
const bpGetByChapterMock = BlueprintRepository.getByChapter as ReturnType<typeof vi.fn>
const draftListMock = DraftRepository.listByChapter as ReturnType<typeof vi.fn>
const draftGetFullMock = DraftRepository.getFull as ReturnType<typeof vi.fn>

beforeEach(() => {
  bpGetAllMock.mockReset()
  bpGetByChapterMock.mockReset()
  draftListMock.mockReset()
  draftGetFullMock.mockReset()
})

describe('read_blueprint', () => {
  it('reads one blueprint by chapter number', async () => {
    bpGetByChapterMock.mockReturnValue({
      chapterNumber: 1, title: '启程', role: '建置', purpose: '引出目标',
      keyEvents: '事件', characters: ['主角'], suspenseHook: '悬念', notes: '', userGuidance: '',
    })
    const tool = createReadBlueprintTool('zh-CN')
    const result = await tool.execute('c1', { chapter_number: 1 })
    const first = result.content[0]
    if (first.type === 'text') expect(first.text).toContain('第 1 章蓝图')
  })

  it('throws for a missing blueprint', async () => {
    bpGetByChapterMock.mockReturnValue(null)
    const tool = createReadBlueprintTool('zh-CN')
    await expect(tool.execute('c1', { chapter_number: 9 })).rejects.toThrow('蓝图不存在')
  })

  it('requires a chapter number instead of listing every blueprint', async () => {
    const tool = createReadBlueprintTool('zh-CN')
    await expect(tool.execute('c1', {} as never)).rejects.toThrow('章节号无效')
    expect(bpGetAllMock).not.toHaveBeenCalled()
  })
})

describe('read_drafts', () => {
  it('reads the latest draft by default', async () => {
    draftListMock.mockReturnValue([
      { id: 2, version: 2, status: 'draft', chapterNumber: 1 },
      { id: 1, version: 1, status: 'draft', chapterNumber: 1 },
    ])
    draftGetFullMock.mockReturnValue({ id: 2, version: 2, content: '正文内容' })
    const tool = createReadDraftsTool('zh-CN')
    const result = await tool.execute('c1', { chapter_number: 1 })
    const first = result.content[0]
    if (first.type === 'text') {
      expect(first.text).toContain('（v2）')
      expect(first.text).toContain('正文内容')
    }
  })

  it('throws when the requested draft type is absent', async () => {
    draftListMock.mockReturnValue([{ id: 1, version: 1, status: 'draft', chapterNumber: 1 }])
    const tool = createReadDraftsTool('zh-CN')
    await expect(tool.execute('c1', { chapter_number: 1, draft_type: 'revised' })).rejects.toThrow('revised')
  })

  it('supports pagination with offset and limit', async () => {
    const lines = ['第一行', '第二行', '第三行', '第四行', '第五行'].join('\n')
    draftListMock.mockReturnValue([{ id: 1, version: 1, status: 'draft', chapterNumber: 2 }])
    draftGetFullMock.mockReturnValue({ id: 1, version: 1, content: lines })

    const tool = createReadDraftsTool('zh-CN')
    const result = await tool.execute('c1', { chapter_number: 2, offset: 2, limit: 2 })
    const first = result.content[0]
    if (first.type === 'text') {
      expect(first.text).toContain('第二行\n第三行')
      expect(first.text).not.toContain('第一行')
      expect(first.text).not.toContain('第四行')
      expect(first.text).toContain('[第 2–3 行 / 共 5 行]')
    }
  })
})
