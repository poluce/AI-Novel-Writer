import { beforeEach, describe, expect, it, vi } from 'vitest'

const loadConfig = vi.fn()
const getServerConfig = vi.fn()
const saveServer = vi.fn()
const updateServer = vi.fn()
const deleteServer = vi.fn()
const connect = vi.fn()
const disconnect = vi.fn()
const getServersStatus = vi.fn()

vi.mock('../../../mcp/mcp-manager', () => ({
  mcpManager: {
    loadConfig: (...args: unknown[]) => loadConfig(...args),
    getServerConfig: (...args: unknown[]) => getServerConfig(...args),
    saveServer: (...args: unknown[]) => saveServer(...args),
    updateServer: (...args: unknown[]) => updateServer(...args),
    deleteServer: (...args: unknown[]) => deleteServer(...args),
    connect: (...args: unknown[]) => connect(...args),
    disconnect: (...args: unknown[]) => disconnect(...args),
    getServersStatus: (...args: unknown[]) => getServersStatus(...args),
  },
}))

import { createManageMcpTool } from '../manage-mcp.tool'

beforeEach(() => {
  loadConfig.mockReset()
  getServerConfig.mockReset()
  saveServer.mockReset()
  updateServer.mockReset()
  deleteServer.mockReset()
  connect.mockReset()
  disconnect.mockReset()
  getServersStatus.mockReset()
})

function textOf(result: Awaited<ReturnType<ReturnType<typeof createManageMcpTool>['execute']>>): string {
  const first = result.content[0]
  return first && first.type === 'text' ? first.text : ''
}

describe('manage_mcp agent tool', () => {
  it('lists configured servers with status and tool count, never credentials', async () => {
    loadConfig.mockResolvedValue({
      status: 'loaded',
      servers: [
        { id: 'docs', name: 'docs', transport: 'stdio' },
        { id: 'web', name: 'web', transport: 'sse' },
      ],
    })
    getServersStatus.mockReturnValue([
      { id: 'docs', name: 'docs', status: 'connected', toolCount: 3 },
    ])

    const tool = createManageMcpTool('zh-CN')
    const result = await tool.execute('c1', { action: 'list' })

    expect(textOf(result)).toContain('docs（stdio）')
    expect(textOf(result)).toContain('工具: 3 个')
    expect(textOf(result)).toContain('web（sse）')
    expect(JSON.stringify(result)).not.toContain('API_KEY')
  })

  it('gracefully handles descriptive action values hallucinated by LLMs', async () => {
    loadConfig.mockResolvedValue({
      status: 'loaded',
      servers: [{ id: 'docs', name: 'docs', transport: 'stdio' }],
    })
    getServersStatus.mockReturnValue([{ id: 'docs', name: 'docs', status: 'connected', toolCount: 3 }])
    const tool = createManageMcpTool('zh-CN')

    const result = await tool.execute('call-desc', {
      action: '列出全部已配置的 MCP 服务器及其连接状态与工具数量（不含凭据）',
    })
    expect(textOf(result)).toContain('docs（stdio）')
  })

  it('reads one server full configuration on demand', async () => {
    getServerConfig.mockResolvedValue({
      success: true,
      config: { id: 'docs', transport: 'stdio', command: 'npx', args: ['-y'], env: { K: 'V' } },
    })

    const tool = createManageMcpTool('zh-CN')
    const result = await tool.execute('c1', { action: 'get', server_id: 'docs' })

    expect(getServerConfig).toHaveBeenCalledWith('docs')
    expect(textOf(result)).toContain('"command": "npx"')
  })

  it('adds a server, saves through the shared seam, and attempts a connection', async () => {
    saveServer.mockResolvedValue({ success: true })
    connect.mockResolvedValue(undefined)
    getServersStatus.mockReturnValue([
      { id: 'new-server', name: 'new-server', status: 'connected', toolCount: 2 },
    ])

    const tool = createManageMcpTool('zh-CN')
    const result = await tool.execute('c1', {
      action: 'add',
      server_id: 'new-server',
      command: 'npx',
      args: ['-y', 'pkg'],
    })

    expect(saveServer).toHaveBeenCalledWith({ id: 'new-server', command: 'npx', args: ['-y', 'pkg'] })
    expect(connect).toHaveBeenCalledWith('new-server')
    expect(textOf(result)).toContain('已添加并连接成功')
  })

  it('partially updates a server through the merge seam and reconnects it', async () => {
    updateServer.mockResolvedValue({ success: true })
    connect.mockResolvedValue(undefined)
    getServersStatus.mockReturnValue([{ id: 'web', name: 'web', status: 'connected', toolCount: 1 }])

    const tool = createManageMcpTool('zh-CN')
    const result = await tool.execute('c1', { action: 'update', server_id: 'web', command: 'npx' })

    // 未提供的字段不发送：管理器负责与现有配置合并。
    expect(updateServer).toHaveBeenCalledWith('web', { command: 'npx' })
    expect(connect).toHaveBeenCalledWith('web')
    expect(textOf(result)).toContain('已更新并重连成功')
  })

  it('updates a server and still reports the outcome when reconnecting fails', async () => {
    updateServer.mockResolvedValue({ success: true })
    // 真实管理器连接失败时抛出的就是这条消毒后的统一文案。
    connect.mockRejectedValue(new Error('MCP 服务器连接失败'))
    getServersStatus.mockReturnValue([{ id: 'web', name: 'web', status: 'error', toolCount: 0 }])

    const tool = createManageMcpTool('zh-CN')
    const result = await tool.execute('c1', { action: 'update', server_id: 'web', url: '' })

    expect(updateServer).toHaveBeenCalledWith('web', { url: '' })
    expect(textOf(result)).toContain('已更新')
    expect(textOf(result)).toContain('MCP 服务器连接失败')
  })

  it('connects and disconnects a server without touching its configuration', async () => {
    connect.mockResolvedValue(undefined)
    disconnect.mockResolvedValue(undefined)
    getServersStatus.mockReturnValue([{ id: 'docs', name: 'docs', status: 'connected', toolCount: 3 }])

    const tool = createManageMcpTool('zh-CN')
    const connected = await tool.execute('c1', { action: 'connect', server_id: 'docs' })
    expect(connect).toHaveBeenCalledWith('docs')
    expect(textOf(connected)).toContain('已连接')

    const disconnected = await tool.execute('c1', { action: 'disconnect', server_id: 'docs' })
    expect(disconnect).toHaveBeenCalledWith('docs')
    expect(textOf(disconnected)).toContain('已断开')
    expect(saveServer).not.toHaveBeenCalled()
    expect(updateServer).not.toHaveBeenCalled()
  })

  it('deletes a server and disconnects it', async () => {
    deleteServer.mockResolvedValue({ success: true })

    const tool = createManageMcpTool('zh-CN')
    const result = await tool.execute('c1', { action: 'delete', server_id: 'doomed' })

    expect(deleteServer).toHaveBeenCalledWith('doomed')
    expect(textOf(result)).toContain('已删除')
  })

  it('surfaces manager errors instead of hiding them', async () => {
    saveServer.mockResolvedValue({ success: false, error: '服务器 ID 不能为空' })

    const tool = createManageMcpTool('zh-CN')
    await expect(tool.execute('c1', { action: 'add', server_id: 'bad id', command: 'node' }))
      .rejects.toThrow('服务器 ID 不能为空')
  })
})
