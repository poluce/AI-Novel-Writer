import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createReadArchitectureTool } from '../read-architecture.tool'

vi.mock('../../../repositories/project-core-repository', () => ({
  ProjectCoreRepository: { get: vi.fn() },
}))

import { ProjectCoreRepository } from '../../../repositories/project-core-repository'

const coreGetMock = ProjectCoreRepository.get as ReturnType<typeof vi.fn>

beforeEach(() => {
  coreGetMock.mockReset()
})

describe('read_architecture', () => {
  it('produces a Pi AgentTool with an optional section schema', () => {
    const tool = createReadArchitectureTool('zh-CN')
    expect(tool.name).toBe('read_architecture')
    expect(typeof tool.execute).toBe('function')
  })

  it('dumps every non-empty section and never the character graph', async () => {
    coreGetMock.mockReturnValue({
      premise: '前提', worldbuilding: '世界观', charactersArch: '角色图谱正文', synopsis: '大纲',
    })
    const tool = createReadArchitectureTool('zh-CN')
    const result = await tool.execute('c1', {})
    const first = result.content[0]
    if (first.type !== 'text') throw new Error('expected text content')
    expect(first.text).toContain('故事前提')
    expect(first.text).toContain('世界观')
    expect(first.text).toContain('情节大纲')
    expect(first.text).toContain('前提')
    expect(first.text).not.toContain('角色图谱正文')
    expect(result.details).toMatchObject({ sections: ['premise', 'worldbuilding', 'synopsis'] })
  })

  it('returns only the requested section and says so when it is empty', async () => {
    coreGetMock.mockReturnValue({ premise: '前提', worldbuilding: '', synopsis: '' })
    const tool = createReadArchitectureTool('zh-CN')
    const result = await tool.execute('c1', { section: 'premise' })
    const first = result.content[0]
    if (first.type !== 'text') throw new Error('expected text content')
    expect(first.text).toContain('前提')

    const missing = await tool.execute('c1', { section: 'worldbuilding' })
    const missingFirst = missing.content[0]
    if (missingFirst.type !== 'text') throw new Error('expected text content')
    expect(missingFirst.text).toContain('世界观尚未生成')
  })

  it('throws when the architecture has not been initialized', async () => {
    coreGetMock.mockReturnValue(null)
    const tool = createReadArchitectureTool('zh-CN')
    await expect(tool.execute('c1', {})).rejects.toThrow('项目架构未初始化')
  })
})

