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
  MCPServerConfigView,
  MCPServerSaveRequest,
  MCPServerStatus,
  MCPServerSummary,
  MCPToolDescription,
} from '../shared/ipc-channels'

type MCPToolData = MCPToolDescription
type MCPResourceData = MCPResourceDescription

// ===== Store 状态 =====

interface MCPState {
  /** 服务器状态列表 */
  servers: MCPServerStatus[]
  /** 已配置的服务器清单（来自 mcp:load-config，不含凭据） */
  configs: MCPServerSummary[]
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
  /** 重新加载配置清单（不自动连接） */
  reloadConfig: () => Promise<void>
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
  /** 按需读取单个服务器的完整配置（设置页编辑用） */
  getServerConfig: (serverId: string) => Promise<{ success: boolean; config?: MCPServerConfigView; error?: string }>
  /** 新增或覆盖一个服务器，成功后刷新配置清单与状态 */
  saveServer: (request: MCPServerSaveRequest) => Promise<{ success: boolean; error?: string }>
  /** 删除一个服务器，成功后刷新配置清单与状态 */
  deleteServer: (serverId: string) => Promise<{ success: boolean; error?: string }>
  /** 切换服务器启用/禁用状态，即时写盘并同步连接 */
  toggleServerDisabled: (serverId: string, disabled: boolean) => Promise<{ success: boolean; error?: string }>
  /** 获取指定服务器已加载的工具列表 */
  toolsForServer: (serverId: string) => MCPToolData[]
}

export const useMCPStore = create<MCPState>()((set, get) => ({
  servers: [],
  configs: [],
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
        set({ loading: false, configs: [], error: result.error ?? 'MCP 配置加载失败' })
        return
      }
      set({ configs: result.servers ?? [] })

      // 自动连接所有未禁用的服务器
      for (const server of result.servers ?? []) {
        if (server.disabled) continue
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

  reloadConfig: async () => {
    const result = await ipc.invoke('mcp:load-config')
    if (!result.success) {
      set({ configs: [], error: result.error ?? 'MCP 配置加载失败' })
      return
    }
    set({ configs: result.servers ?? [], error: null })
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

  getServerConfig: async (serverId) => {
    try {
      const result = await ipc.invoke('mcp:get-server-config', serverId) as {
        success: boolean
        config?: MCPServerConfigView
        error?: string
      }
      return result
    } catch (error) {
      logFailure('MCP', 'get server config failed', error, { serverId })
      return { success: false, error: String(error) }
    }
  },

  saveServer: async (request) => {
    try {
      const result = await ipc.invoke('mcp:save-server', request) as {
        success: boolean
        error?: string
      }
      if (!result.success) {
        set({ error: result.error ?? 'MCP 服务器保存失败' })
        return result
      }
      // 保存成功：刷新配置清单与状态，并尝试连接刚保存的服务器。
      await get().reloadConfig()
      await get().connectServer(request.id).catch(() => {})
      await get().refreshStatus()
      await get().refreshTools()
      return { success: true }
    } catch (error) {
      logFailure('MCP', 'save server failed', error, { serverId: request.id })
      return { success: false, error: String(error) }
    }
  },

  deleteServer: async (serverId) => {
    try {
      const result = await ipc.invoke('mcp:delete-server', serverId) as {
        success: boolean
        error?: string
      }
      if (!result.success) {
        set({ error: result.error ?? 'MCP 服务器删除失败' })
        return result
      }
      await get().reloadConfig()
      await get().refreshStatus()
      await get().refreshTools()
      return { success: true }
    } catch (error) {
      logFailure('MCP', 'delete server failed', error, { serverId })
      return { success: false, error: String(error) }
    }
  },

  toggleServerDisabled: async (serverId: string, disabled: boolean) => {
    try {
      const serverConfig = await get().getServerConfig(serverId)
      if (!serverConfig.success || !serverConfig.config) {
        return { success: false, error: serverConfig.error ?? '无法读取服务器配置' }
      }
      const res = await get().saveServer({
        ...serverConfig.config,
        disabled,
      })
      if (!res.success) return res

      if (disabled) {
        await get().disconnectServer(serverId)
      } else {
        try {
          await get().connectServer(serverId)
        } catch {
          // 状态已由 connectServer 记录并触发更新
        }
      }
      await get().refreshTools()
      await get().refreshStatus()
      return { success: true }
    } catch (error) {
      logFailure('MCP', 'toggle server disabled failed', error, { serverId, disabled })
      return { success: false, error: String(error) }
    }
  },

  toolsForServer: (serverId: string) => {
    return get().tools.filter(t => t.serverId === serverId)
  },
}))

// 主进程任一写入方（设置页或项目助手的 manage_mcp）改了配置，都实时同步到界面。
if (typeof window !== 'undefined') {
  ipc.on('mcp:config-changed', () => {
    const state = useMCPStore.getState()
    void state.reloadConfig()
    void state.refreshStatus()
    void state.refreshTools()
  })
}
