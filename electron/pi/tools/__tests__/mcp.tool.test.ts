import { beforeEach, describe, expect, it, vi } from 'vitest'

const getAllTools = vi.fn()
const callTool = vi.fn()

vi.mock('../../../mcp/mcp-manager', () => ({
  mcpManager: {
    getAllTools: () => getAllTools(),
    callTool: (...args: unknown[]) => callTool(...args),
  },
}))

import { buildMcpAgentTools, mcpAgentToolName } from '../mcp.tool'
import { TOOL_RESULT_MAX_CHARS } from '../../tool-result'

beforeEach(() => {
  getAllTools.mockReset()
  callTool.mockReset()
})

describe('MCP Agent tools', () => {
  it('exposes connected MCP tools with a namespaced AgentTool name', async () => {
    getAllTools.mockReturnValue([
      { name: 'search', description: 'Search docs', inputSchema: {}, serverId: 'docs' },
    ])
    callTool.mockResolvedValue({ success: true, content: 'hit' })

    const tools = buildMcpAgentTools('zh-CN')
    expect(tools.map(tool => tool.name)).toEqual([mcpAgentToolName('docs', 'search')])

    const result = await tools[0]!.execute('c1', { q: '潮门' })
    expect(callTool).toHaveBeenCalledWith('docs', 'search', { q: '潮门' })
    const first = result.content[0]
    if (first.type === 'text') expect(first.text).toBe('hit')
  })

  it('truncates long MCP observations', async () => {
    getAllTools.mockReturnValue([
      { name: 'dump', description: 'Dump', inputSchema: {}, serverId: 'docs' },
    ])
    callTool.mockResolvedValue({ success: true, content: '长'.repeat(TOOL_RESULT_MAX_CHARS + 10) })

    const [tool] = buildMcpAgentTools('en-US')
    const result = await tool!.execute('c1', {})
    const first = result.content[0]
    if (first.type === 'text') {
      expect(first.text.length).toBe(TOOL_RESULT_MAX_CHARS + 2)
      expect(first.text.endsWith('\n…')).toBe(true)
    }
  })
})
