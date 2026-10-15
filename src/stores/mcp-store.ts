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

interface MCPState {
  servers: MCPServerStatus[]
  configs: MCPServerSummary[]
  tools: MCPToolDescription[]
  resources: MCPResourceDescription[]
  configPath: string | null
  loading: boolean
  error: string | null

  init: () => Promise<void>
  reloadConfig: () => Promise<void>
  refreshStatus: () => Promise<void>
  connectServer: (serverId: string) => Promise<void>
  disconnectServer: (serverId: string) => Promise<void>
  disconnectAll: () => Promise<void>
  refreshTools: () => Promise<void>
  registerMCPToolsToRegistry: () => void
  getServerConfig: (serverId: string) => Promise<{ success: boolean; config?: MCPServerConfigView; error?: string }>
  saveServer: (request: MCPServerSaveRequest) => Promise<{ success: boolean; error?: string }>
  deleteServer: (serverId: string) => Promise<{ success: boolean; error?: string }>
  toggleServerDisabled: (serverId: string, disabled: boolean) => Promise<{ success: boolean; error?: string }>
  toolsForServer: (serverId: string) => MCPToolDescription[]
}

export const useMCPStore = create<MCPState>()((set, get) => {
  async function refreshRuntime(): Promise<void> {
    await get().refreshStatus()
    await get().refreshTools()
  }

  return {
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
        const configPath = await ipc.invoke('mcp:get-config-path')
        set({ configPath })

        const result = await ipc.invoke('mcp:load-config')
        if (!result.success) {
          set({ loading: false, configs: [], error: result.error ?? 'MCP 配置加载失败' })
          return
        }
        set({ configs: result.servers ?? [] })

        for (const server of result.servers ?? []) {
          if (server.disabled) continue
          try {
            const connection = await ipc.invoke('mcp:connect', server.id)
            if (!connection.success) {
              set({ error: connection.error ?? '连接失败' })
            }
          } catch (error) {
            console.warn(`[MCP] 连接 ${server.id} 失败:`, error)
            set({ error: 'MCP 服务器连接失败' })
          }
        }

        await refreshRuntime()
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
        set({ servers })
      } catch (error) {
        console.error('[MCP] 刷新状态失败:', error)
      }
    },

    connectServer: async (serverId) => {
      const result = await ipc.invoke('mcp:connect', serverId)
      if (!result.success) {
        set({ error: result.error ?? '连接失败' })
      }
      await refreshRuntime()
      get().registerMCPToolsToRegistry()
    },

    disconnectServer: async (serverId) => {
      await ipc.invoke('mcp:disconnect', serverId)
      await refreshRuntime()
      get().registerMCPToolsToRegistry()
    },

    disconnectAll: async () => {
      await ipc.invoke('mcp:disconnect-all')
      set({ servers: [], tools: [], resources: [] })
    },

    refreshTools: async () => {
      try {
        const tools = await ipc.invoke('mcp:list-tools')
        const resources = await ipc.invoke('mcp:list-resources')
        set({ tools, resources })
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
        return await ipc.invoke('mcp:get-server-config', serverId)
      } catch (error) {
        logFailure('MCP', 'get server config failed', error, { serverId })
        return { success: false, error: String(error) }
      }
    },

    saveServer: async (request) => {
      try {
        const result = await ipc.invoke('mcp:save-server', request)
        if (!result.success) {
          set({ error: result.error ?? 'MCP 服务器保存失败' })
          return result
        }
        await get().reloadConfig()
        await get().connectServer(request.id).catch(() => {})
        return { success: true }
      } catch (error) {
        logFailure('MCP', 'save server failed', error, { serverId: request.id })
        return { success: false, error: String(error) }
      }
    },

    deleteServer: async (serverId) => {
      try {
        const result = await ipc.invoke('mcp:delete-server', serverId)
        if (!result.success) {
          set({ error: result.error ?? 'MCP 服务器删除失败' })
          return result
        }
        await get().reloadConfig()
        await refreshRuntime()
        return { success: true }
      } catch (error) {
        logFailure('MCP', 'delete server failed', error, { serverId })
        return { success: false, error: String(error) }
      }
    },

    toggleServerDisabled: async (serverId, disabled) => {
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
        if (disabled) await get().disconnectServer(serverId)
        return { success: true }
      } catch (error) {
        logFailure('MCP', 'toggle server disabled failed', error, { serverId, disabled })
        return { success: false, error: String(error) }
      }
    },

    toolsForServer: (serverId) => get().tools.filter(tool => tool.serverId === serverId),
  }
})

// 主进程任一写入方（设置页或项目助手的 manage_mcp）改了配置，都实时同步到界面。
if (typeof window !== 'undefined') {
  ipc.on('mcp:config-changed', () => {
    const state = useMCPStore.getState()
    void state.reloadConfig()
    void state.refreshStatus()
    void state.refreshTools()
  })
}
