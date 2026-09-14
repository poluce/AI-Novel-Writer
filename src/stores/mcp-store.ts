/**
 * MCP Store — 前端 MCP 状态管理
 *
 * 管理 MCP 服务器的连接状态、可用 Tool 列表、配置加载等。
 * 通过 IPC 与主进程的 mcpManager 通信。
 */

import { create } from 'zustand'
import { ipc } from '../services/ipc-client'
import { logFailure } from '../shared/fail-log'
import type {
  MCPResourceDescription,
  MCPServerStatus,
  MCPToolDescription,
} from '../shared/ipc-channels'

type MCPToolData = MCPToolDescription
type MCPResourceData = MCPResourceDescription

// ===== Store 状态 =====

interface MCPState {
  /** 服务器状态列表 */
  servers: MCPServerStatus[]
  /** 所有 MCP Tool */
  tools: MCPToolData[]
  /** 所有 MCP 资源 */
  resources: MCPResourceData[]
  /** 配置文件路径 */
  configPath: string | null
  /** 加载中 */
  loading: boolean
  /** 错误 */
  error: string | null

  // ===== Actions =====
  /** 初始化（加载配置 + 自动连接） */
  init: () => Promise<void>
  /** 刷新服务器状态 */
  refreshStatus: () => Promise<void>
  /** 连接单个服务器 */
  connectServer: (serverId: string) => Promise<void>
  /** 断开单个服务器 */
  disconnectServer: (serverId: string) => Promise<void>
  /** 断开所有服务器 */
  disconnectAll: () => Promise<void>
  /** 刷新 Tool 列表 */
  refreshTools: () => Promise<void>
  /** 将 MCP Tool 注册到 ToolRegistry */
  registerMCPToolsToRegistry: () => void
}

export const useMCPStore = create<MCPState>()((set, get) => ({
  servers: [],
  tools: [],
  resources: [],
  configPath: null,
  loading: false,
  error: null,

  init: async () => {
    set({ loading: true, error: null })
    try {
      // 获取配置文件路径
      const configPath = await ipc.invoke('mcp:get-config-path')
      set({ configPath })

      // 加载配置
      const result = await ipc.invoke('mcp:load-config')
      if (!result.success) {
        set({ loading: false, error: result.error ?? 'MCP 配置加载失败' })
        return
      }

      // 自动连接所有配置的服务器
      for (const server of result.servers) {
        try {
          const connection = await ipc.invoke('mcp:connect', server.id)
          if (!connection.success) {
            set({ error: connection.error ?? '连接失败' })
          }
        } catch (e) {
          console.warn(`[MCP] 连接 ${server.id} 失败:`, e)
          set({ error: 'MCP 服务器连接失败' })
        }
      }

      // 刷新状态
      await get().refreshStatus()
      await get().refreshTools()

      // 注册到 ToolRegistry
      get().registerMCPToolsToRegistry()

      set({ loading: false })
    } catch (error) {
      set({ loading: false, error: String(error) })
    }
  },

  refreshStatus: async () => {
    try {
      const servers = await ipc.invoke('mcp:get-servers-status')
      set({ servers: servers as unknown as MCPServerStatus[] })
    } catch (error) {
      console.error('[MCP] 刷新状态失败:', error)
    }
  },

  connectServer: async (serverId) => {
    const result = await ipc.invoke('mcp:connect', serverId)
    if (!result.success) {
      set({ error: result.error ?? '连接失败' })
      return
    }
    await get().refreshStatus()
    await get().refreshTools()
    get().registerMCPToolsToRegistry()
  },

  disconnectServer: async (serverId) => {
    await ipc.invoke('mcp:disconnect', serverId)
    await get().refreshStatus()
    await get().refreshTools()
    get().registerMCPToolsToRegistry()
  },

  disconnectAll: async () => {
    await ipc.invoke('mcp:disconnect-all')
    set({ servers: [], tools: [], resources: [] })
  },

  refreshTools: async () => {
    try {
      const tools = await ipc.invoke('mcp:list-tools') as unknown[]
      const resources = await ipc.invoke('mcp:list-resources') as unknown[]
      set({ tools: tools as MCPToolData[], resources: resources as MCPResourceData[] })
    } catch (error) {
      logFailure('MCP', 'refresh tools/resources failed', error)
    }
  },

  registerMCPToolsToRegistry: () => {
    // MCP 工具由主进程 Pi Agent 以 `mcp__server__name` 提供并执行；
    // 渲染层只展示清单，不再维护任何工具注册表。
  },
}))
