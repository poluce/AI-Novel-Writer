import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createReadProjectStateTool } from '../read-project-state.tool'

vi.mock('../../../repositories/project-core-repository', () => ({
  ProjectCoreRepository: { get: vi.fn() },
}))
vi.mock('../../../repositories/blueprint-repository', () => ({
  BlueprintRepository: { getAll: vi.fn() },
}))
vi.mock('../../../repositories/draft-repository', () => ({
  DraftRepository: { listAll: vi.fn() },
}))

import { ProjectCoreRepository } from '../../../repositories/project-core-repository'
import { BlueprintRepository } from '../../../repositories/blueprint-repository'
import { DraftRepository } from '../../../repositories/draft-repository'

const coreGetMock = ProjectCoreRepository.get as ReturnType<typeof vi.fn>
const bpGetAllMock = BlueprintRepository.getAll as ReturnType<typeof vi.fn>
const draftListMock = DraftRepository.listAll as ReturnType<typeof vi.fn>

beforeEach(() => {
  coreGetMock.mockReset()
  bpGetAllMock.mockReset()
  draftListMock.mockReset()
  draftListMock.mockReturnValue([])
})

describe('read_project_state', () => {
  it('renders config, chapter progress, recent notes, and the blueprint list by default', async () => {
    coreGetMock.mockReturnValue({
      projectName: '测试小说', genre: 'fantasy', subGenre: '', targetAudience: 'male',
      totalChapters: 10, wordsPerChapter: 2000, plotStructure: 'three-act',
      narrativePov: 'third', writingStyle: '简洁',
    })
    bpGetAllMock.mockReturnValue([
      { chapterNumber: 2, title: '第二章', notes: '要点2' },
      { chapterNumber: 1, title: '第一章', notes: '要点1' },
    ])
    draftListMock.mockReturnValue([
      { chapterNumber: 1, status: 'finalized' },
      { chapterNumber: 2, status: 'draft' },
    ])

    const tool = createReadProjectStateTool('zh-CN')
    const result = await tool.execute('c1', {})
    const first = result.content[0]
    if (first.type !== 'text') throw new Error('expected text content')
    expect(first.text).toContain('测试小说')
    expect(first.text).toContain('小说配置')
    expect(first.text).toContain('章节进度')
    expect(first.text).toContain('| 1 | ✅ | ✅ | ✅ |')
    expect(first.text).toContain('| 2 | ✅ | ✅ | ❌ |')
    expect(first.text).toContain('近章要点')
    expect(first.text).toContain('要点1')
    expect(first.text).toContain('蓝图清单（2 个）')
    expect(first.text).toContain('第 1 章: 第一章')
    expect(result.details).toMatchObject({ chapters: 2 })
  })

  it('returns only the requested sections', async () => {
    coreGetMock.mockReturnValue(null)
    bpGetAllMock.mockReturnValue([])

    const tool = createReadProjectStateTool('zh-CN')
    const result = await tool.execute('c1', { sections: ['config'] })
    const first = result.content[0]
    if (first.type !== 'text') throw new Error('expected text content')
    expect(first.text).toContain('小说配置')
    expect(first.text).not.toContain('章节进度')
    expect(first.text).not.toContain('近章要点')
    expect(first.text).not.toContain('蓝图清单')
    expect(result.details).toMatchObject({ sections: ['config'] })
  })

  it('falls back to every section when the request is empty', async () => {
    coreGetMock.mockReturnValue({ projectName: '空项目', totalChapters: 0, wordsPerChapter: 0 })
    bpGetAllMock.mockReturnValue([])

    const tool = createReadProjectStateTool('zh-CN')
    const result = await tool.execute('c1', { sections: [] })
    const first = result.content[0]
    if (first.type !== 'text') throw new Error('expected text content')
    expect(first.text).toContain('小说配置')
    expect(first.text).toContain('章节进度')
    expect(first.text).toContain('近章要点')
    expect(first.text).toContain('蓝图清单')
  })

  it('truncates long chapter lists and keeps the total count visible', async () => {
    coreGetMock.mockReturnValue({ projectName: '长篇', totalChapters: 5000, wordsPerChapter: 2000 })
    bpGetAllMock.mockReturnValue(Array.from({ length: 250 }, (_, index) => ({
      chapterNumber: index + 1,
      title: `第${index + 1}章`,
      notes: '',
    })))

    const tool = createReadProjectStateTool('zh-CN')
    const result = await tool.execute('c1', { sections: ['progress'] })
    const first = result.content[0]
    if (first.type !== 'text') throw new Error('expected text content')
    expect(first.text).toContain('共 250 章，仅列出前 200 章')
    expect(first.text).toContain('| 200 |')
    expect(first.text).not.toContain('| 201 |')
  })

  it('builds every section in English for an English project', async () => {
    coreGetMock.mockReturnValue({
      projectName: 'Novel', genre: 'fantasy', subGenre: '', targetAudience: 'adult',
      totalChapters: 10, wordsPerChapter: 2000, plotStructure: 'three_act',
      narrativePov: 'third_limited', writingStyle: 'plain',
    })
    bpGetAllMock.mockReturnValue([{ chapterNumber: 1, title: 'One', notes: 'note' }])
    draftListMock.mockReturnValue([{ chapterNumber: 1, status: 'finalized' }])

    const tool = createReadProjectStateTool('en-US')
    const result = await tool.execute('c1', {})
    const first = result.content[0]
    if (first.type !== 'text') throw new Error('expected text content')
    expect(first.text).toContain('Novel configuration')
    expect(first.text).toContain('Chapter progress')
    expect(first.text).toContain('Recent chapter notes')
    expect(first.text).toContain('Blueprints (1)')
    expect(first.text).not.toMatch(/[\u3400-\u9fff]/u)
  })
})
