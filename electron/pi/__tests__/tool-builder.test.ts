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

import { buildAgentTools } from '../tool-builder'

describe('buildAgentTools', () => {
  it('marks write and MCP tools sequential', () => {
    const tools = buildAgentTools('zh-CN', () => {})
    const write = tools.find(tool => tool.name === 'write_file')
    const mcp = tools.find(tool => tool.name === 'mcp__docs__search')
    const read = tools.find(tool => tool.name === 'read_file')
    expect(write?.executionMode).toBe('sequential')
    expect(mcp?.executionMode).toBe('sequential')
    expect(read?.executionMode).toBeUndefined()
  })
})
