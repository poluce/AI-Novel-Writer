import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createNovelConfigTool } from '../novel-config.tool'
import { createStoryArchitectureTool } from '../story-architecture.tool'
import { ProjectCoreRepository } from '../../../repositories/project-core-repository'

vi.mock('../../../repositories/project-core-repository', () => ({
  ProjectCoreRepository: {
    get: vi.fn(),
    update: vi.fn(),
  },
}))

describe('novel_config tool', () => {
  const mockCore = {
    projectName: '天命大反派',
    genre: '玄幻',
    subGenre: '系统',
    targetAudience: '青年',
    totalChapters: 120,
    wordsPerChapter: 3000,
    plotStructure: 'three_act',
    narrativePov: 'third_limited',
    writingLanguage: 'zh-CN',
    coreOutline: '主角穿越成为反派圣子，开始逆天改命。',
    worldSetting: '上界下界三千州，强者为尊。',
    goldenFinger: '天道气运掠夺系统',
    protagonistProfile: '顾长歌，天生重瞳至尊骨，心思缜密冷酷。',
    globalGuidance: '不无脑送女，杀伐果断。',
    writingStyle: '快节奏，偏爽文。',
    referenceWorks: '',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(ProjectCoreRepository.get).mockReturnValue(mockCore as never)
  })

  it('reads specific fields using standard English identifiers', async () => {
    const tool = createNovelConfigTool('zh-CN', () => {})
    const result = await tool.execute('call-1', {
      action: 'read',
      field: 'goldenFinger',
    })
    expect(result.details.action).toBe('read')
    expect(result.content[0].type).toBe('text')
    expect((result.content[0] as { text: string }).text).toContain('天道气运掠夺系统')
  })

  it('reads all fields when field is not specified', async () => {
    const tool = createNovelConfigTool('zh-CN', () => {})
    const result = await tool.execute('call-2', {})
    expect(result.details.action).toBe('read')
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('基本信息')
    expect(text).toContain('核心大纲')
    expect(text).toContain('顾长歌')
  })

  it('updates specific field via field and content params', async () => {
    const actions: unknown[] = []
    const tool = createNovelConfigTool('zh-CN', (a) => { actions.push(a) })
    const result = await tool.execute('call-3', {
      action: 'update',
      field: 'coreOutline',
      content: '全新大纲：决战神域之巅。',
    })
    expect(result.details.action).toBe('update')
    expect(ProjectCoreRepository.update).toHaveBeenCalledWith(expect.objectContaining({
      coreOutline: '全新大纲：决战神域之巅。',
    }))
    expect(actions).toEqual([{ type: 'refresh_project_config' }])
  })

  it('updates multiple fields directly', async () => {
    const actions: unknown[] = []
    const tool = createNovelConfigTool('zh-CN', (a) => { actions.push(a) })
    await tool.execute('call-4', {
      goldenFinger: '大道吞噬经',
      protagonistProfile: '林玄，坚毅不屈。',
    })
    expect(ProjectCoreRepository.update).toHaveBeenCalledWith(expect.objectContaining({
      goldenFinger: '大道吞噬经',
      protagonistProfile: '林玄，坚毅不屈。',
    }))
    expect(actions).toEqual([{ type: 'refresh_project_config' }])
  })

  it('replaces a targeted excerpt in coreOutline without modifying the rest', async () => {
    const actions: unknown[] = []
    const tool = createNovelConfigTool('zh-CN', (a) => { actions.push(a) })
    const result = await tool.execute('call-5', {
      action: 'update',
      field: 'coreOutline',
      old_text: '穿越成为反派圣子',
      new_text: '重生为魔道至尊',
    })
    expect(result.details.action).toBe('update')
    expect(ProjectCoreRepository.update).toHaveBeenCalledWith(expect.objectContaining({
      coreOutline: '主角重生为魔道至尊，开始逆天改命。',
    }))
    expect(actions).toEqual([{ type: 'refresh_project_config' }])
  })

  it('throws helpful error when old_text does not exist in novel_config', async () => {
    const tool = createNovelConfigTool('zh-CN', () => {})
    await expect(tool.execute('call-6', {
      action: 'update',
      field: 'coreOutline',
      old_text: '不存在的段落文字',
      new_text: '替换文字',
    })).rejects.toThrow('未找到指定的待替换原文片段')
  })
})

describe('story_architecture tool', () => {
  const mockCore = {
    premise: '当废柴少年意外激活残卷，必须在宗门大比前突破筑基，否则将被逐出师门。',
    worldbuilding: '青云界共分九州，修仙境界为练气、筑基、金丹、元婴。',
    synopsis: '第1-10章：外门崛起；第11-20章：秘境争夺。',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(ProjectCoreRepository.get).mockReturnValue(mockCore as never)
  })

  it('reads all sections by default', async () => {
    const tool = createStoryArchitectureTool('zh-CN', () => {})
    const result = await tool.execute('call-1', {})
    expect(result.details.action).toBe('read')
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('故事前提')
    expect(text).toContain('青云界')
    expect(text).toContain('第1-10章')
  })

  it('reads specific section with standard English section name', async () => {
    const tool = createStoryArchitectureTool('zh-CN', () => {})
    const result = await tool.execute('call-2', {
      section: 'worldbuilding',
    })
    expect(result.details.action).toBe('read')
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('青云界')
    expect(text).not.toContain('废柴少年')
  })

  it('updates specific section via section and content', async () => {
    const actions: unknown[] = []
    const tool = createStoryArchitectureTool('zh-CN', (a) => { actions.push(a) })
    const result = await tool.execute('call-3', {
      action: 'update',
      section: 'synopsis',
      content: '详细全书大纲：第一卷至第五卷纲要...',
    })
    expect(result.details.action).toBe('update')
    expect(ProjectCoreRepository.update).toHaveBeenCalledWith({
      synopsis: '详细全书大纲：第一卷至第五卷纲要...',
    })
    expect(actions).toEqual([{ type: 'refresh_architecture', section: 'synopsis' }])
  })

  it('updates sections directly with named params', async () => {
    const actions: unknown[] = []
    const tool = createStoryArchitectureTool('zh-CN', (a) => { actions.push(a) })
    await tool.execute('call-4', {
      premise: '新故事前提...',
      worldbuilding: '新世界观...',
    })
    expect(ProjectCoreRepository.update).toHaveBeenCalledWith({
      premise: '新故事前提...',
      worldbuilding: '新世界观...',
    })
    expect(actions).toContainEqual({ type: 'refresh_architecture', section: 'premise' })
    expect(actions).toContainEqual({ type: 'refresh_architecture', section: 'worldbuilding' })
  })

  it('replaces a targeted excerpt in synopsis without modifying the rest of the outline', async () => {
    const actions: unknown[] = []
    const tool = createStoryArchitectureTool('zh-CN', (a) => { actions.push(a) })
    const result = await tool.execute('call-5', {
      action: 'update',
      section: 'synopsis',
      old_text: '第11-20章：秘境争夺。',
      new_text: '第11-20章：远古遗迹试炼与反杀。',
    })
    expect(result.details.action).toBe('update')
    expect(ProjectCoreRepository.update).toHaveBeenCalledWith({
      synopsis: '第1-10章：外门崛起；第11-20章：远古遗迹试炼与反杀。',
    })
    expect(actions).toEqual([{ type: 'refresh_architecture', section: 'synopsis' }])
  })
})
