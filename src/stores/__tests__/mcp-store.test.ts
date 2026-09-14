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
