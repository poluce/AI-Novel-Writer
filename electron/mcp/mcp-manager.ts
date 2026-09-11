/**
 * MCP（Model Context Protocol）连接管理器
 *
 * 运行在 Electron 主进程，通过 stdio/SSE 管理与外部 MCP Server 的连接。
 * 兼容 Claude Desktop 的配置格式 (claude_desktop_config.json)。
 *
 * 架构：
 * - 主进程负责 MCP 连接的生命周期（启动子进程 / 建立 SSE）
 * - 通过 IPC 将可用 Tool 列表暴露给渲染进程
 * - 渲染进程通过 IPC 调用 MCP Tool
 */

import { readFile } from 'fs/promises'
import { join } from 'path'
import { isDeepStrictEqual } from 'node:util'
import { VELA_HOME } from '../utils/config-utils'
import { openMcpSdkSession, type McpSdkSession } from './mcp-sdk-session'
import type {
  MCPConfigLoadResult,
  MCPConnectionStatus,
  MCPResourceDescription,
  MCPServerStatus,
  MCPServerSummary,
  MCPToolDescription,
} from '../../src/shared/ipc-channels'

// ===== 类型定义 =====

/** MCP 服务器配置（兼容 Claude Desktop 格式） */
export interface MCPServerConfig {
  /** 服务器唯一 ID */
  id: string
  /** 显示名称 */
  name: string
  /** 传输协议 */
  transport: 'stdio' | 'sse'
  /** stdio 模式：要执行的命令 */
  command?: string
  /** stdio 模式：命令参数 */
  args?: string[]
  /** stdio 模式：环境变量 */
  env?: Record<string, string>
  /** SSE 模式：服务器 URL */
  url?: string
}

/** MCP 配置文件格式（兼容 Claude Desktop） */
export interface MCPConfig {
  mcpServers: Record<string, {
    command?: string
    args?: string[]
    env?: Record<string, string>
    url?: string
  }>
}

/** MCP Tool 描述 */
export interface MCPToolDesc extends MCPToolDescription {
  /** 工具名（MCP 原始名称） */
  name: string
  /** 描述 */
  description: string
  /** 输入 JSON Schema */
  inputSchema: Record<string, unknown>
  /** 所属服务器 ID */
  serverId: string
}

/** MCP 资源描述 */
export interface MCPResourceDesc extends MCPResourceDescription {
  uri: string
  name: string
  description?: string
  mimeType?: string
  serverId: string
}

/** 服务器连接状态 */
/** 服务器运行时状态 */
interface MCPServerRuntime {
  config: MCPServerConfig
  status: MCPConnectionStatus
  session?: McpSdkSession
  tools: MCPToolDesc[]
  resources: MCPResourceDesc[]
  error?: string
}

// ===== MCP Manager 实现 =====

class MCPManagerImpl {
  private servers: Map<string, MCPServerRuntime> = new Map()
  private loadedConfigs: Map<string, MCPServerConfig> = new Map()

  /** 状态变更通知回调（通知渲染进程） */
  private onStatusChange?: (serverId: string, status: MCPConnectionStatus, error?: string) => void
  /** Tool 列表变更回调 */
  private onToolsChange?: (tools: MCPToolDesc[]) => void

  /** 设置状态变更回调 */
  setCallbacks(callbacks: {
    onStatusChange?: (serverId: string, status: MCPConnectionStatus, error?: string) => void
    onToolsChange?: (tools: MCPToolDesc[]) => void
  }) {
    this.onStatusChange = callbacks.onStatusChange
    this.onToolsChange = callbacks.onToolsChange
  }

  /** 获取 MCP 配置文件默认路径 */
  getDefaultConfigPath(): string {
    return join(VELA_HOME, 'mcp_config.json')
  }

  /**
   * 加载 MCP 配置文件
   * 兼容 Claude Desktop 格式
   */
  async loadConfig(): Promise<MCPConfigLoadResult> {
    const path = this.getDefaultConfigPath()
    this.loadedConfigs.clear()
    const revoke = async (result: MCPConfigLoadResult): Promise<MCPConfigLoadResult> => {
      await this.disconnectAll()
      return result
    }
    try {
      const raw = await readFile(path, 'utf-8')
      const parsed: unknown = JSON.parse(raw)

      if (
        !parsed
        || typeof parsed !== 'object'
        || !('mcpServers' in parsed)
        || !parsed.mcpServers
        || typeof parsed.mcpServers !== 'object'
        || Array.isArray(parsed.mcpServers)
      ) {
        return revoke({ status: 'error', servers: [], error: 'MCP 配置损坏，未加载任何服务器' })
      }

      const servers: MCPServerSummary[] = []
      const trustedConfigs = new Map<string, MCPServerConfig>()
      for (const [id, value] of Object.entries(parsed.mcpServers)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return revoke({ status: 'error', servers: [], error: 'MCP 配置损坏，未加载任何服务器' })
        }
        const cfg = value as MCPConfig['mcpServers'][string]
        if (
          (cfg.command !== undefined && typeof cfg.command !== 'string')
          || (cfg.args !== undefined && (!Array.isArray(cfg.args) || cfg.args.some(arg => typeof arg !== 'string')))
          || (cfg.env !== undefined && (
            !cfg.env
            || typeof cfg.env !== 'object'
            || Array.isArray(cfg.env)
            || Object.values(cfg.env).some(entry => typeof entry !== 'string')
          ))
          || (cfg.url !== undefined && typeof cfg.url !== 'string')
        ) {
          return revoke({ status: 'error', servers: [], error: 'MCP 配置损坏，未加载任何服务器' })
        }
        const hasCommand = typeof cfg.command === 'string' && cfg.command.trim().length > 0
        const hasUrl = typeof cfg.url === 'string' && cfg.url.trim().length > 0
        if (hasCommand === hasUrl) {
          return revoke({ status: 'error', servers: [], error: 'MCP 配置损坏，未加载任何服务器' })
        }
        const trustedConfig: MCPServerConfig = {
          id,
          name: id,
          transport: hasUrl ? 'sse' : 'stdio',
          command: cfg.command,
          args: cfg.args,
          env: cfg.env,
          url: cfg.url,
        }
        trustedConfigs.set(id, trustedConfig)
        servers.push({ id, name: id, transport: trustedConfig.transport })
      }
      for (const [id, runtime] of this.servers) {
        const trustedConfig = trustedConfigs.get(id)
        if (!trustedConfig || !isDeepStrictEqual(runtime.config, trustedConfig)) {
          await this.disconnect(id)
        }
      }
      this.loadedConfigs = trustedConfigs
      return { status: 'loaded', servers }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return revoke({ status: 'missing', servers: [] })
      }
      return revoke({ status: 'error', servers: [], error: 'MCP 配置损坏或无法读取，未加载任何服务器' })
    }
  }

  /**
   * 连接到 MCP 服务器
   */
  async connect(serverId: string): Promise<void> {
    const config = this.loadedConfigs.get(serverId)
    if (!config) throw new Error('MCP 服务器未配置或配置尚未加载')
    if (this.servers.has(config.id)) {
      await this.disconnect(config.id)
    }

    const runtime: MCPServerRuntime = {
      config,
      status: 'connecting',
      tools: [],
      resources: [],
    }
    this.servers.set(config.id, runtime)
    this.notifyStatusChange(config.id, 'connecting')

    try {
      runtime.session = await new Promise<NonNullable<MCPServerRuntime['session']>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('MCP 请求超时: initialize')), 10_000)
        openMcpSdkSession(config).then(
          session => {
            clearTimeout(timer)
            resolve(session)
          },
          error => {
            clearTimeout(timer)
            reject(error)
          },
        )
      })
      await this.discoverTools(runtime)
      await this.discoverResources(runtime)
      runtime.status = 'connected'
      this.notifyStatusChange(config.id, 'connected')
      this.notifyToolsChange()
    } catch {
      await runtime.session?.close().catch(() => {})
      runtime.session = undefined
      runtime.status = 'error'
      runtime.error = 'MCP 服务器连接失败'
      this.notifyStatusChange(config.id, 'error', runtime.error)
      throw new Error(runtime.error)
    }
  }

  /** 发现可用工具 */
  private async discoverTools(runtime: MCPServerRuntime): Promise<void> {
    try {
      const result = await runtime.session!.listTools()
      runtime.tools = (result.tools ?? []).map(tool => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
        serverId: runtime.config.id,
      }))
    } catch {
      runtime.tools = []
    }
  }

  /** 发现可用资源 */
  private async discoverResources(runtime: MCPServerRuntime): Promise<void> {
    try {
      const result = await runtime.session!.listResources()
      runtime.resources = (result.resources ?? []).map(resource => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
        serverId: runtime.config.id,
      }))
    } catch {
      runtime.resources = []
    }
  }

  /**
   * 调用 MCP Tool
   */
  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<{
    success: boolean
    content: string
    error?: string
  }> {
    const runtime = this.servers.get(serverId)
    if (!runtime || runtime.status !== 'connected') {
      return { success: false, content: '', error: `服务器 ${serverId} 未连接` }
    }

    try {
      const result = await runtime.session!.callTool(toolName, args)
      const textParts = (result.content ?? [])
        .filter(c => c.type === 'text')
        .map(c => c.text ?? '')
        .join('\n')
      return { success: true, content: textParts }
    } catch (error) {
      return { success: false, content: '', error: String(error) }
    }
  }

  /** 断开服务器连接 */
  async disconnect(serverId: string): Promise<void> {
    const runtime = this.servers.get(serverId)
    if (!runtime) return

    await runtime.session?.close().catch(() => {})
    this.servers.delete(serverId)
    this.notifyStatusChange(serverId, 'disconnected')
    this.notifyToolsChange()
  }

  /** 断开所有连接 */
  async disconnectAll(): Promise<void> {
    for (const id of this.servers.keys()) {
      await this.disconnect(id)
    }
  }

  /** 获取所有 MCP Tool */
  getAllTools(): MCPToolDesc[] {
    const tools: MCPToolDesc[] = []
    for (const runtime of this.servers.values()) {
      if (runtime.status === 'connected') {
        tools.push(...runtime.tools)
      }
    }
    return tools
  }

  /** 获取所有 MCP 资源 */
  getAllResources(): MCPResourceDesc[] {
    const resources: MCPResourceDesc[] = []
    for (const runtime of this.servers.values()) {
      if (runtime.status === 'connected') {
        resources.push(...runtime.resources)
      }
    }
    return resources
  }

  /** 获取所有服务器状态 */
  getServersStatus(): MCPServerStatus[] {
    return Array.from(this.servers.values()).map(r => ({
      id: r.config.id,
      name: r.config.name,
      status: r.status,
      toolCount: r.tools.length,
      error: r.error,
    }))
  }

  private notifyStatusChange(serverId: string, status: MCPConnectionStatus, error?: string) {
    this.onStatusChange?.(serverId, status, error)
  }

  private notifyToolsChange() {
    this.onToolsChange?.(this.getAllTools())
  }
}

/** 全局单例 MCP Manager */
export const mcpManager = new MCPManagerImpl()
