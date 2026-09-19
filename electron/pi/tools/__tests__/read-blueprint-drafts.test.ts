import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createReadBlueprintTool } from '../read-blueprint.tool'

vi.mock('../../../repositories/blueprint-repository', () => ({
  BlueprintRepository: { getAll: vi.fn(), getByChapter: vi.fn() },
}))

import { BlueprintRepository } from '../../../repositories/blueprint-repository'

const bpGetAllMock = BlueprintRepository.getAll as ReturnType<typeof vi.fn>
const bpGetByChapterMock = BlueprintRepository.getByChapter as ReturnType<typeof vi.fn>

beforeEach(() => {
  bpGetAllMock.mockReset()
  bpGetByChapterMock.mockReset()
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

  it('returns friendly notice without throwing for a missing blueprint', async () => {
    bpGetByChapterMock.mockReturnValue(null)
    const tool = createReadBlueprintTool('zh-CN')
    const result = await tool.execute('c1', { chapter_number: 9 })
    const first = result.content[0]
    if (first.type === 'text') expect(first.text).toContain('第 9 章蓝图目前尚未创建')
  })

  it('requires a chapter number instead of listing every blueprint', async () => {
    const tool = createReadBlueprintTool('zh-CN')
    await expect(tool.execute('c1', {} as never)).rejects.toThrow('章节号无效')
    expect(bpGetAllMock).not.toHaveBeenCalled()
  })
})
