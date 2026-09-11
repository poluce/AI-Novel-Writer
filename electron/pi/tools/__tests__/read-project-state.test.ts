import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createReadProjectStateTool } from '../read-project-state.tool'

vi.mock('../../../repositories/project-core-repository', () => ({
  ProjectCoreRepository: { get: vi.fn() },
}))
vi.mock('../../../repositories/blueprint-repository', () => ({
  BlueprintRepository: { getAll: vi.fn() },
}))

import { ProjectCoreRepository } from '../../../repositories/project-core-repository'
import { BlueprintRepository } from '../../../repositories/blueprint-repository'

const coreGetMock = ProjectCoreRepository.get as ReturnType<typeof vi.fn>
const bpGetAllMock = BlueprintRepository.getAll as ReturnType<typeof vi.fn>

beforeEach(() => {
  coreGetMock.mockReset()
  bpGetAllMock.mockReset()
})

describe('read_project_state', () => {
  it('renders config and recent chapter notes', async () => {
    coreGetMock.mockReturnValue({
      projectName: '测试小说', genre: 'fantasy', subGenre: '', targetAudience: 'male',
      totalChapters: 10, wordsPerChapter: 2000, plotStructure: 'three-act',
      narrativePov: 'third', writingStyle: '简洁',
    })
    bpGetAllMock.mockReturnValue([
      { chapterNumber: 2, title: '第二章', notes: '要点2' },
      { chapterNumber: 1, title: '第一章', notes: '要点1' },
    ])

    const tool = createReadProjectStateTool('zh-CN')
    const result = await tool.execute('c1', {})
    const first = result.content[0]
    if (first.type === 'text') {
      expect(first.text).toContain('测试小说')
      expect(first.text).toContain('小说配置')
      expect(first.text).toContain('近章要点')
      expect(first.text).toContain('要点1')
    }
  })

  it('omits config and summary when both flags are false', async () => {
    coreGetMock.mockReturnValue(null)
    bpGetAllMock.mockReturnValue([])

    const tool = createReadProjectStateTool('zh-CN')
    const result = await tool.execute('c1', { include_config: false, include_summary: false })
    const first = result.content[0]
    if (first.type === 'text') {
      expect(first.text).not.toContain('小说配置')
      expect(first.text).not.toContain('近章要点')
    }
  })
})
