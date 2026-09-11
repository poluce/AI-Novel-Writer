import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createReadArchitectureTool } from '../read-architecture.tool'
import { createReadCharactersTool } from '../read-characters.tool'

vi.mock('../../../repositories/project-core-repository', () => ({
  ProjectCoreRepository: { get: vi.fn() },
}))
vi.mock('../../../repositories/character-repository', () => ({
  CharacterRepository: { getAll: vi.fn() },
}))

import { ProjectCoreRepository } from '../../../repositories/project-core-repository'
import { CharacterRepository } from '../../../repositories/character-repository'

const coreGetMock = ProjectCoreRepository.get as ReturnType<typeof vi.fn>
const charsGetAllMock = CharacterRepository.getAll as ReturnType<typeof vi.fn>

beforeEach(() => {
  coreGetMock.mockReset()
  charsGetAllMock.mockReset()
})

describe('read_architecture', () => {
  it('produces a Pi AgentTool with an optional file_name schema', () => {
    const tool = createReadArchitectureTool('zh-CN')
    expect(tool.name).toBe('read_architecture')
    expect(typeof tool.execute).toBe('function')
  })

  it('dumps every non-empty architecture section', async () => {
    coreGetMock.mockReturnValue({
      premise: '前提', worldbuilding: '世界观', charactersArch: '', synopsis: '大纲',
    })
    const tool = createReadArchitectureTool('zh-CN')
    const result = await tool.execute('c1', {})
    const first = result.content[0]
    if (first.type === 'text') {
      expect(first.text).toContain('premise.md')
      expect(first.text).toContain('worldbuilding.md')
      expect(first.text).toContain('synopsis.md')
      expect(first.text).not.toContain('characters.md')
    }
  })

  it('throws when the architecture has not been initialized', async () => {
    coreGetMock.mockReturnValue(null)
    const tool = createReadArchitectureTool('zh-CN')
    await expect(tool.execute('c1', {})).rejects.toThrow('项目架构未初始化')
  })
})

describe('read_characters', () => {
  it('lists characters by name and role', async () => {
    charsGetAllMock.mockReturnValue([
      { id: 1, name: '主角', role: 'protagonist' },
      { id: 2, name: '配角', role: 'supporting' },
    ])
    const tool = createReadCharactersTool('zh-CN')
    const result = await tool.execute('c1', {})
    const first = result.content[0]
    if (first.type === 'text') {
      expect(first.text).toContain('主角 (protagonist)')
      expect(first.text).toContain('配角 (supporting)')
    }
  })

  it('throws when a requested character is missing', async () => {
    charsGetAllMock.mockReturnValue([{ id: 1, name: '主角', role: 'protagonist' }])
    const tool = createReadCharactersTool('zh-CN')
    await expect(tool.execute('c1', { character_name: '不存在' })).rejects.toThrow('未找到角色')
  })
})
