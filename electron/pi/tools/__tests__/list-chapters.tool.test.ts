import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createListChaptersTool } from '../list-chapters.tool'

vi.mock('../../../repositories/blueprint-repository', () => ({
  BlueprintRepository: { getAll: vi.fn() },
}))
vi.mock('../../../repositories/draft-repository', () => ({
  DraftRepository: { listAll: vi.fn() },
}))

import { BlueprintRepository } from '../../../repositories/blueprint-repository'
import { DraftRepository } from '../../../repositories/draft-repository'

const getAllMock = BlueprintRepository.getAll as ReturnType<typeof vi.fn>
const listAllMock = DraftRepository.listAll as ReturnType<typeof vi.fn>

beforeEach(() => {
  getAllMock.mockReset()
  listAllMock.mockReset()
})

describe('createListChaptersTool', () => {
  it('produces a Pi AgentTool with the expected identity and empty schema', () => {
    const tool = createListChaptersTool('zh-CN')

    expect(tool.name).toBe('list_chapters')
    expect(tool.label).toBe('List Chapters')
    expect(typeof tool.description).toBe('string')
    expect(tool.parameters).toBeDefined()
    expect(typeof tool.execute).toBe('function')
  })

  it('localizes the model-facing description by writing language', () => {
    expect(createListChaptersTool('en-US').description).toContain('List every chapter')
    expect(createListChaptersTool('zh-CN').description).toContain('列出项目中所有章节')
  })

  it('builds the progress table and details from repository rows', async () => {
    getAllMock.mockReturnValue([{ chapterNumber: 1 }])
    listAllMock.mockReturnValue([
      { chapterNumber: 1, status: 'draft' },
      { chapterNumber: 2, status: 'finalized' },
    ])

    const tool = createListChaptersTool('zh-CN')
    const result = await tool.execute('call-1', {})

    expect(result.details).toEqual({ total: 2, blueprints: 1, drafts: 2, finalized: 1 })
    expect(result.content).toHaveLength(1)
    const first = result.content[0]
    expect(first.type).toBe('text')
    if (first.type === 'text') {
      expect(first.text).toContain('章节进度概览')
      expect(first.text).toContain('| 1 | ✅ | ✅ | ❌ |')
      expect(first.text).toContain('| 2 | ❌ | ✅ | ✅ |')
    }
  })
})
