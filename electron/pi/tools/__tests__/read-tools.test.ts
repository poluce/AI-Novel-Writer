import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createReadArchitectureTool } from '../read-architecture.tool'
import { createReadCharactersTool } from '../read-characters.tool'

vi.mock('../../../repositories/project-core-repository', () => ({
  ProjectCoreRepository: { get: vi.fn() },
}))
vi.mock('../../../repositories/character-roster-repository', () => ({
  CharacterRosterRepository: { read: vi.fn() },
  renderCharacterRosterMarkdown: vi.fn(() => '# 角色图谱\n\n## 主角：主角'),
}))

import { ProjectCoreRepository } from '../../../repositories/project-core-repository'
import { CharacterRosterRepository } from '../../../repositories/character-roster-repository'

const coreGetMock = ProjectCoreRepository.get as ReturnType<typeof vi.fn>
const rosterReadMock = CharacterRosterRepository.read as ReturnType<typeof vi.fn>

function roster(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    revision: 3,
    migrationState: 'ready',
    status: 'ready',
    entries: [],
    renderedMarkdown: '',
    projectionHash: 'projection',
    factHash: 'facts',
    ...overrides,
  }
}

beforeEach(() => {
  coreGetMock.mockReset()
  rosterReadMock.mockReset()
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

describe('read_characters', () => {
  it('lists the authoritative roster entries and the rendered projection', async () => {
    rosterReadMock.mockReturnValue(roster({
      entries: [
        { name: '主角', role: 'protagonist', relationships: [], currentState: { location: '铁砧镇', updatedAtChapter: 3 } },
        { name: '配角', role: 'supporting', relationships: [] },
      ],
    }))
    const tool = createReadCharactersTool('zh-CN')
    const result = await tool.execute('c1', {})
    const first = result.content[0]
    if (first.type !== 'text') throw new Error('expected text content')
    expect(first.text).toContain('主角 (protagonist)')
    expect(first.text).toContain('配角 (supporting)')
    expect(first.text).toContain('# 角色图谱')
    expect(result.details).toMatchObject({ total: 2, status: 'ready' })
  })

  it('reads one character profile including current state', async () => {
    rosterReadMock.mockReturnValue(roster({
      entries: [{
        name: '主角',
        role: 'protagonist',
        gender: '男',
        appearance: '瘦高',
        personality: '执拗',
        background: '学徒',
        abilities: '灵脉感知',
        motivation: '寻找家人',
        arc: '从被动到主动',
        notes: '',
        relationships: [{ target: '配角', relation: '同门' }],
        currentState: {
          location: '宗门废墟',
          powerLevel: '筑基',
          physicalState: '轻伤',
          mentalState: '警觉',
          keyItems: '旧铁锤',
          recentEvents: '破门',
          updatedAtChapter: 21,
        },
      }],
    }))
    const tool = createReadCharactersTool('zh-CN')
    const result = await tool.execute('c1', { character_name: '主角' })
    const first = result.content[0]
    if (first.type !== 'text') throw new Error('expected text content')
    expect(first.text).toContain('外貌: 瘦高')
    expect(first.text).toContain('关系：配角（同门）')
    expect(first.text).toContain('当前状态')
    expect(first.text).toContain('location: 宗门废墟')
    expect(first.text).toContain('updatedAtChapter: 21')
  })

  it('throws when a requested character is missing', async () => {
    rosterReadMock.mockReturnValue(roster({
      entries: [{ name: '主角', role: 'protagonist', relationships: [] }],
    }))
    const tool = createReadCharactersTool('zh-CN')
    await expect(tool.execute('c1', { character_name: '不存在' })).rejects.toThrow('未找到角色')
  })

  it('falls back to the preserved legacy text when the roster is not structured', async () => {
    rosterReadMock.mockReturnValue(roster({
      status: 'legacy_repair_required',
      entries: [],
      legacyMarkdown: '旧角色图谱原文',
    }))
    const tool = createReadCharactersTool('zh-CN')
    const result = await tool.execute('c1', {})
    const first = result.content[0]
    if (first.type !== 'text') throw new Error('expected text content')
    expect(first.text).toContain('legacy_repair_required')
    expect(first.text).toContain('旧角色图谱原文')
    expect(result.details).toMatchObject({ total: 0, status: 'legacy_repair_required' })
  })

  it('reports an empty roster instead of an empty answer', async () => {
    rosterReadMock.mockReturnValue(roster({ status: 'empty', entries: [] }))
    const tool = createReadCharactersTool('zh-CN')
    const result = await tool.execute('c1', {})
    const first = result.content[0]
    if (first.type !== 'text') throw new Error('expected text content')
    expect(first.text).toContain('角色名单为空')
  })
})
