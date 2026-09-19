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

import { buildAgentTools, confirmationToolNames } from '../tool-builder'

describe('buildAgentTools', () => {
  it('keeps every tool name flat, colon-free and snake case', () => {
    // 工具名是单层平坦名字空间：harness 按名字做全局唯一校验，名字里不允许冒号
    // （Gemini 的函数名规范同样只接受字母数字、下划线、点、横线）。唯一的“前缀”
    // 是 MCP 的 `mcp__<服务器>__<工具名>` 约定，用的也是下划线。
    const names = [
      ...buildAgentTools('zh-CN', () => {}, 'project').map(tool => tool.name),
      ...buildAgentTools('zh-CN', () => {}, 'global').map(tool => tool.name),
    ]
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      expect(name).not.toContain(':')
      expect(name).toMatch(/^[a-z0-9_]+$/)
    }
  })

  it('gives the app assistant only project-free tools', () => {
    const names = buildAgentTools('zh-CN', () => {}, 'global').map(tool => tool.name)
    // 没有项目时项目读写工具只会失败，一律不挂。
    for (const projectTool of [
      'novel_config', 'story_architecture',
      'read_architecture', 'manage_characters', 'read_blueprint', 'manage_drafts',
      'read_project_state', 'search_knowledge', 'read_file',
      'install_writing_skill', 'bind_writing_skill', 'open_editor',
      'propose_chapter_blueprint',
    ]) {
      expect(names).not.toContain(projectTool)
    }
    // 技能检查与 MCP 与项目无关，保留。
    expect(names).toContain('inspect_writing_skill')
    expect(names).toContain('mcp__docs__search')
    // 渐进式披露的读取端两个作用域都有。
    expect(names).toContain('load_writing_skill')
    expect(buildAgentTools('zh-CN', () => {}, 'project').map(tool => tool.name))
      .toContain('load_writing_skill')
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
      'bind_writing_skill',
      'edit',
      'install_writing_skill',
      'manage_characters',
      'manage_drafts',
      'novel_config',
      'open_editor',
      'propose_chapter_blueprint',
      'story_architecture',
      'write',
    ])
  })
})
