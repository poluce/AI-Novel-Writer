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
  it('marks write and MCP tools sequential so reads can run in parallel', () => {
    const tools = buildAgentTools('zh-CN', () => {})
    const write = tools.find(tool => tool.name === 'write_file')
    const replace = tools.find(tool => tool.name === 'replace_draft_excerpt')
    const mcp = tools.find(tool => tool.name === 'mcp__docs__search')
    const read = tools.find(tool => tool.name === 'read_file')
    const drafts = tools.find(tool => tool.name === 'read_drafts')
    expect(write?.executionMode).toBe('sequential')
    expect(replace?.executionMode).toBe('sequential')
    expect(mcp?.executionMode).toBe('sequential')
    expect(read?.executionMode).toBeUndefined()
    expect(drafts?.executionMode).toBeUndefined()
  })

  it('exposes one overview tool and no list_chapters', () => {
    const tools = buildAgentTools('zh-CN', () => {})
    const names = tools.map(tool => tool.name)

    expect(names).not.toContain('list_chapters')
    expect(names).toContain('read_project_state')
    expect(names).toContain('read_blueprint')
    // 角色事实只有 read_characters 一个来源。
    expect(names).toContain('read_characters')
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
      'bind_writing_skill',
      'install_writing_skill',
      'open_editor',
      'propose_chapter_blueprint',
      'propose_novel_config',
      'replace_draft_excerpt',
      'start_workflow',
      'write_file',
    ])
  })
})
