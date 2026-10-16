import { describe, expect, it, vi } from 'vitest'

vi.mock('../../mcp/mcp-manager', () => ({
  mcpManager: {
    getAllTools: () => [{
      name: 'search',
      description: 'Search',
      inputSchema: {},
      serverId: 'docs',
    }],
  },
}))
vi.mock('../../database', () => ({ getCurrentProjectPath: vi.fn() }))

import { buildAgentTools, buildArchitectAgentTools, buildBlueprintAgentTools, confirmationToolNames, sequentialToolNames } from '../tool-builder'

describe('buildAgentTools', () => {
  it('keeps every tool name flat, colon-free and snake case', () => {
    // 工具名是单层平坦名字空间：harness 按名字做全局唯一校验，名字里不允许冒号
    // （Gemini 的函数名规范同样只接受字母数字、下划线、点、横线）。唯一的“前缀”
    // 是 MCP 的 `mcp__<服务器>__<工具名>` 约定，用的也是下划线。
    const names = buildAgentTools('zh-CN', () => {}).map(tool => tool.name)
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      expect(name).not.toContain(':')
      expect(name).toMatch(/^[a-z0-9_]+$/)
    }
  })

  it('always mounts the full project tool set', () => {
    const names = buildAgentTools('zh-CN', () => {}).map(tool => tool.name)
    for (const projectTool of [
      'novel_config', 'story_architecture',
      'read_architecture', 'manage_characters', 'read_blueprint', 'manage_drafts',
      'read_project_state', 'search_knowledge', 'read_file',
      'manage_skills', 'open_editor',
      'propose_chapter_blueprint', 'manage_mcp',
    ]) {
      expect(names).toContain(projectTool)
    }
    expect(names).toContain('mcp__docs__search')
    expect(names).not.toContain('load_writing_skill')
    expect(names).not.toContain('inspect_writing_skill')
    expect(names).not.toContain('install_writing_skill')
  })

  it('marks write and MCP tools sequential so reads can run in parallel', () => {
    const tools = buildAgentTools('zh-CN', () => {})
    const novelConfig = tools.find(tool => tool.name === 'novel_config')
    const manageDrafts = tools.find(tool => tool.name === 'manage_drafts')
    const mcp = tools.find(tool => tool.name === 'mcp__docs__search')
    const read = tools.find(tool => tool.name === 'read_file')
    expect(novelConfig?.executionMode).toBe('sequential')
    expect(manageDrafts?.executionMode).toBe('sequential')
    expect(mcp?.executionMode).toBe('sequential')
    expect(read?.executionMode).toBeUndefined()
  })

  it('exposes one overview tool and no list_chapters', () => {
    const tools = buildAgentTools('zh-CN', () => {})
    const names = tools.map(tool => tool.name)

    expect(names).not.toContain('list_chapters')
    expect(names).toContain('read_project_state')
    expect(names).toContain('read_blueprint')
    // 角色事实统一通过 manage_characters 进行读取与管理。
    expect(names).toContain('manage_characters')
  })

  it('gives every built-in tool an English description without Chinese fallback', () => {
    const tools = buildAgentTools('en-US', () => {})

    for (const tool of tools) {
      if (tool.name.startsWith('mcp__')) continue
      expect(tool.description, tool.name).toBeTruthy()
      expect(`${tool.description}\n${tool.name}`, tool.name).not.toMatch(/[\u3400-\u9fff]/u)
    }
  })

  it('keeps only the intended tools behind user confirmation', () => {
    expect([...confirmationToolNames()].sort()).toEqual([
      // harness 自带的执行工具同样逐次确认。
      'bash',
      'edit',
      'manage_characters',
      'manage_drafts',
      'manage_knowledge_base',
      'manage_mcp',
      'manage_skills',
      'novel_config',
      'open_editor',
      'propose_chapter_blueprint',
      'story_architecture',
      'write',
    ])
  })

  it('keeps sequentialToolNames explicitly defined and decoupled from confirmation', () => {
    expect([...sequentialToolNames()].sort()).toEqual([
      'bash',
      'edit',
      'manage_characters',
      'manage_drafts',
      'manage_knowledge_base',
      'manage_mcp',
      'manage_skills',
      'novel_config',
      'open_editor',
      'propose_chapter_blueprint',
      'story_architecture',
      'write',
    ])
  })
})

describe('buildArchitectAgentTools', () => {
  it('mounts strictly focused architecture and worldbuilding tools without raw write or draft tools', () => {
    const tools = buildArchitectAgentTools('zh-CN', () => {})
    const names = tools.map(t => t.name)

    // 包含的架构工具
    expect(names).toContain('novel_config')
    expect(names).toContain('story_architecture')
    expect(names).toContain('read_architecture')
    expect(names).toContain('read_blueprint')
    expect(names).toContain('read_project_state')
    expect(names).toContain('search_knowledge')
    expect(names).toContain('manage_knowledge_base')
    expect(names).toContain('read_file')
    expect(names).toContain('open_editor')
    expect(names).toContain('propose_chapter_blueprint')
    expect(names).toContain('manage_characters')
    expect(names).toContain('web_fetch')

    // 严禁包含破坏性写工具与正文草稿工具
    expect(names).not.toContain('manage_drafts')
    expect(names).not.toContain('write')
    expect(names).not.toContain('edit')
    expect(names).not.toContain('bash')
    expect(names).not.toContain('manage_skills')
    expect(names).not.toContain('manage_mcp')
  })

  it('marks sequential tools appropriately for serial execution', () => {
    const tools = buildArchitectAgentTools('zh-CN', () => {})
    const novelConfig = tools.find(tool => tool.name === 'novel_config')
    const storyArch = tools.find(tool => tool.name === 'story_architecture')
    const read = tools.find(tool => tool.name === 'read_file')

    expect(novelConfig?.executionMode).toBe('sequential')
    expect(storyArch?.executionMode).toBe('sequential')
    expect(read?.executionMode).toBeUndefined()
  })
})

describe('buildBlueprintAgentTools', () => {
  it('mounts chapter blueprint tools and excludes draft prose tools and raw OS tools', () => {
    const tools = buildBlueprintAgentTools('zh-CN', () => {})
    const names = tools.map(t => t.name)

    // 包含的核心工具
    expect(names).toContain('propose_chapter_blueprint')
    expect(names).toContain('read_blueprint')
    expect(names).toContain('read_project_state')
    expect(names).toContain('read_architecture')
    expect(names).toContain('manage_characters')
    expect(names).toContain('search_knowledge')
    expect(names).toContain('read_file')
    expect(names).toContain('open_editor')
    expect(names).toContain('web_fetch')

    // 严禁包含的工具
    expect(names).not.toContain('manage_drafts')
    expect(names).not.toContain('write')
    expect(names).not.toContain('edit')
    expect(names).not.toContain('bash')
    expect(names).not.toContain('manage_skills')
    expect(names).not.toContain('manage_mcp')
  })

  it('marks blueprint proposal sequential', () => {
    const tools = buildBlueprintAgentTools('zh-CN', () => {})
    const proposeBlueprint = tools.find(tool => tool.name === 'propose_chapter_blueprint')
    const readBlueprint = tools.find(tool => tool.name === 'read_blueprint')

    expect(proposeBlueprint?.executionMode).toBe('sequential')
    expect(readBlueprint?.executionMode).toBeUndefined()
  })
})
