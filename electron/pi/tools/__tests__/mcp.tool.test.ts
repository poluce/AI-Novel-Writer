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
import { TOOL_RESULT_MAX_CHARS, truncateToolResultContent } from '../../tool-result'

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

  it('returns the raw MCP observation: the agent caps it on afterToolCall', async () => {
    getAllTools.mockReturnValue([
      { name: 'dump', description: 'Dump', inputSchema: {}, serverId: 'docs' },
    ])
    callTool.mockResolvedValue({ success: true, content: '长'.repeat(TOOL_RESULT_MAX_CHARS + 10) })

    const [tool] = buildMcpAgentTools('en-US')
    const result = await tool!.execute('c1', {})
    const first = result.content[0]
    if (first.type === 'text') {
      expect(first.text.length).toBe(TOOL_RESULT_MAX_CHARS + 10)
      expect(first.text.endsWith('…')).toBe(false)
    }
    // 上限由 afterToolCall 统一施加（见 pi-agent 与 tool-result 测试）。
    const capped = truncateToolResultContent(result.content)
    const cappedFirst = capped[0]
    if (cappedFirst.type === 'text') {
      expect(cappedFirst.text).toContain('[… truncated')
    }
  })

  it('preserves multimodal ImageContent blocks for Pi Agent without text-only degradation', async () => {
    getAllTools.mockReturnValue([
      { name: 'generate_image', description: 'Draw', inputSchema: {}, serverId: 'painter' },
    ])
    callTool.mockResolvedValue({
      success: true,
      content: '[Image: image/png]',
      items: [
        { type: 'text', text: '插画生成完成：' },
        { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', mimeType: 'image/png' },
      ],
    })

    const [tool] = buildMcpAgentTools('zh-CN')
    const result = await tool!.execute('c1', {})
    expect(result.content).toHaveLength(2)
    expect(result.content[0]).toEqual({ type: 'text', text: '插画生成完成：' })
    expect(result.content[1]).toEqual({
      type: 'image',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      mimeType: 'image/png',
    })
  })
})
