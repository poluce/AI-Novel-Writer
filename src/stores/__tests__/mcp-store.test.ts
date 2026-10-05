import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('../../services/ipc-client', () => ({
  ipc: { invoke: mocks.invoke },
}))

import { useMCPStore } from '../mcp-store'

beforeEach(() => {
  vi.clearAllMocks()
  useMCPStore.setState({
    servers: [],
    tools: [],
    resources: [],
    configPath: null,
    loading: false,
    error: null,
  })
})

describe('renderer MCP trust boundary', () => {
  it('initializes and connects using safe server ids only', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'mcp:get-config-path') return 'C:/isolated/.vela/mcp_config.json'
      if (channel === 'mcp:load-config') {
        return {
          success: true,
          status: 'loaded',
          servers: [{ id: 'safe-id', name: 'Safe server', transport: 'stdio' }],
        }
      }
      if (channel === 'mcp:connect') return { success: true }
      if (channel === 'mcp:get-servers-status') return []
      if (channel === 'mcp:list-tools' || channel === 'mcp:list-resources') return []
      throw new Error(`unexpected IPC: ${channel}`)
    })

    await useMCPStore.getState().init()

    expect(mocks.invoke).toHaveBeenCalledWith('mcp:connect', 'safe-id')
    expect(mocks.invoke.mock.calls.find(([channel]) => channel === 'mcp:connect')?.[1])
      .toBeTypeOf('string')
    expect(useMCPStore.getState()).toMatchObject({ loading: false, error: null })
  })

  it('shows corrupt configuration errors but treats missing configuration as empty', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'mcp:get-config-path') return 'C:/isolated/.vela/mcp_config.json'
      if (channel === 'mcp:load-config') {
        return { success: false, status: 'error', servers: [], error: 'MCP 配置损坏' }
      }
      throw new Error(`unexpected IPC: ${channel}`)
    })

    await useMCPStore.getState().init()
    expect(useMCPStore.getState()).toMatchObject({ loading: false, error: 'MCP 配置损坏' })

    useMCPStore.setState({ error: null })
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'mcp:get-config-path') return 'C:/isolated/.vela/mcp_config.json'
      if (channel === 'mcp:load-config') {
        return { success: true, status: 'missing', servers: [] }
      }
      throw new Error(`unexpected IPC: ${channel}`)
    })
    await useMCPStore.getState().init()
    expect(useMCPStore.getState()).toMatchObject({ loading: false, error: null })
  })

  it('keeps the renderer free of any tool registry: MCP tools execute in the main-process Pi Agent', () => {
    useMCPStore.setState({
      tools: [{
        name: 'write_remote',
        description: 'Writes remote state',
        inputSchema: { type: 'object' },
        serverId: 'safe-id',
      }],
    })

    // 渲染层不再维护工具注册表；这里只要求调用不抛错，且不产生任何 IPC 副作用。
    expect(() => useMCPStore.getState().registerMCPToolsToRegistry()).not.toThrow()
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(useMCPStore.getState().tools).toHaveLength(1)

    // 静态契约：商店源码里不得再出现工具注册表。
    const source = readFileSync(resolve('src/stores/mcp-store.ts'), 'utf8')
    expect(source).not.toContain('toolRegistry')
    expect(source).toContain('主进程 Pi Agent')
  })
})

describe('renderer MCP server management', () => {
  beforeEach(() => {
    useMCPStore.setState({ configs: [] })
  })

  it('saves a new server, reloads the config list, and attempts a connection', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => {
      switch (channel) {
        case 'mcp:save-server': return { success: true }
        case 'mcp:load-config': return {
          success: true,
          status: 'loaded',
          servers: [{ id: 'saved', name: 'saved', transport: 'stdio' }],
        }
        case 'mcp:connect': return { success: true }
        case 'mcp:get-servers-status': return []
        case 'mcp:list-tools': case 'mcp:list-resources': return []
        default: throw new Error(`unexpected IPC: ${channel}`)
      }
    })

    const result = await useMCPStore.getState().saveServer({ id: 'saved', command: 'node' })

    expect(result).toEqual({ success: true })
    expect(mocks.invoke).toHaveBeenCalledWith('mcp:save-server', { id: 'saved', command: 'node' })
    expect(mocks.invoke).toHaveBeenCalledWith('mcp:connect', 'saved')
    expect(useMCPStore.getState().configs).toEqual([
      { id: 'saved', name: 'saved', transport: 'stdio' },
    ])
  })

  it('surfaces a save failure and does not attempt a connection', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'mcp:save-server') return { success: false, error: '服务器 ID 不能为空' }
      throw new Error(`unexpected IPC: ${channel}`)
    })

    const result = await useMCPStore.getState().saveServer({ id: '', command: 'node' })

    expect(result).toEqual({ success: false, error: '服务器 ID 不能为空' })
    expect(useMCPStore.getState().error).toBe('服务器 ID 不能为空')
    expect(mocks.invoke).not.toHaveBeenCalledWith('mcp:connect', expect.anything())
  })

  it('deletes a server and refreshes the config list', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => {
      switch (channel) {
        case 'mcp:delete-server': return { success: true }
        case 'mcp:load-config': return { success: true, status: 'loaded', servers: [] }
        case 'mcp:get-servers-status': return []
        case 'mcp:list-tools': case 'mcp:list-resources': return []
        default: throw new Error(`unexpected IPC: ${channel}`)
      }
    })

    const result = await useMCPStore.getState().deleteServer('doomed')

    expect(result).toEqual({ success: true })
    expect(mocks.invoke).toHaveBeenCalledWith('mcp:delete-server', 'doomed')
    expect(useMCPStore.getState().configs).toEqual([])
  })

  it('reads one server configuration on demand', async () => {
    mocks.invoke.mockResolvedValue({
      success: true,
      config: { id: 'edit-me', transport: 'sse', url: 'https://example.invalid/sse' },
    })

    await expect(useMCPStore.getState().getServerConfig('edit-me')).resolves.toMatchObject({
      success: true,
      config: { id: 'edit-me', transport: 'sse' },
    })
    expect(mocks.invoke).toHaveBeenCalledWith('mcp:get-server-config', 'edit-me')
  })
})
