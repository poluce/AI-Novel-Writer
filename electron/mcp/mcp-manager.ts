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
import { VELA_HOME, writeJsonFile } from '../utils/config-utils'
import { openMcpSdkSession, type McpSdkSession } from './mcp-sdk-session'
import { logFailure } from '../../src/shared/fail-log'
import type {
  MCPConfigLoadResult,
  MCPConnectionStatus,
  MCPResourceDescription,
  MCPServerConfigView,
  MCPServerSaveRequest,
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
  /** 是否禁用 */
  disabled?: boolean
}

/** MCP 配置文件格式（兼容 Claude Desktop） */
export interface MCPConfig {
  mcpServers: Record<string, {
    command?: string
    args?: string[]
    env?: Record<string, string>
    url?: string
    disabled?: boolean
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

export type MCPContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export interface MCPCallToolResult {
  success: boolean
  content: string
  items?: MCPContentBlock[]
  error?: string
}

/**
 * 校验单个服务器条目的唯一权威 Seam：加载、读取与保存都走这里。
 *
 * - stdio 与 SSE 二选一：command 非空 = stdio，url 非空 = SSE；
 * - args/env/url/command 的类型逐一校验，未知字段一律忽略。
 */
function parseServerEntry(
  id: string,
  value: unknown,
): { ok: true; config: MCPServerConfig } | { ok: false } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false }
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
    return { ok: false }
  }
  const hasCommand = typeof cfg.command === 'string' && cfg.command.trim().length > 0
  const hasUrl = typeof cfg.url === 'string' && cfg.url.trim().length > 0
  if (hasCommand === hasUrl) return { ok: false }
  const disabled = typeof cfg.disabled === 'boolean' ? cfg.disabled : undefined
  return {
    ok: true,
    config: {
      id,
      name: id,
      transport: hasUrl ? 'sse' : 'stdio',
      command: hasCommand ? cfg.command : undefined,
      args: cfg.args,
      env: cfg.env,
      url: hasUrl ? cfg.url : undefined,
      disabled,
    },
  }
}

/** 受信配置 → 磁盘条目（Claude Desktop 兼容，只写该传输方式相关字段）。 */
function serializeServerEntry(config: MCPServerConfig): MCPConfig['mcpServers'][string] {
  const base = config.transport === 'sse'
    ? { url: config.url ?? '' }
    : {
        command: config.command ?? '',
        ...(config.args && config.args.length > 0 ? { args: config.args } : {}),
        ...(config.env && Object.keys(config.env).length > 0 ? { env: config.env } : {}),
      }
  return {
    ...base,
    ...(config.disabled ? { disabled: true } : {}),
  }
}

function toConfigView(config: MCPServerConfig): MCPServerConfigView {
  return {
    id: config.id,
    transport: config.transport,
    command: config.command,
    args: config.args,
    env: config.env,
    url: config.url,
    disabled: config.disabled,
  }
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
        const parsedEntry = parseServerEntry(id, value)
        if (!parsedEntry.ok) {
          return revoke({ status: 'error', servers: [], error: 'MCP 配置损坏，未加载任何服务器' })
        }
        const trustedConfig = parsedEntry.config
        trustedConfigs.set(id, trustedConfig)
        servers.push({
          id,
          name: id,
          transport: trustedConfig.transport,
          disabled: trustedConfig.disabled,
        })
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
   * 读取磁盘配置文件对象；文件不存在返回 null，内容损坏则抛出。
   */
  private async readConfigObject(): Promise<MCPConfig | null> {
    let raw: string
    try {
      raw = await readFile(this.getDefaultConfigPath(), 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const parsed: unknown = JSON.parse(raw)
    if (
      !parsed
      || typeof parsed !== 'object'
      || Array.isArray(parsed)
      || !('mcpServers' in parsed)
      || !parsed.mcpServers
      || typeof parsed.mcpServers !== 'object'
      || Array.isArray(parsed.mcpServers)
    ) {
      throw new Error('MCP 配置损坏或无法读取')
    }
    return parsed as MCPConfig
  }

  /**
   * 按需读取单个服务器的完整配置（设置页编辑用）。
   * 与 loadConfig 的摘要下发不同：这里只返回用户明确点开的那一条。
   */
  async getServerConfig(serverId: string): Promise<
    | { success: true; config: MCPServerConfigView }
    | { success: false; error: string }
  > {
    if (!serverId || typeof serverId !== 'string') return { success: false, error: '服务器 ID 无效' }
    try {
      const config = await this.readConfigObject()
      if (!config) return { success: false, error: 'MCP 配置文件不存在' }
      const parsedEntry = parseServerEntry(serverId, config.mcpServers[serverId])
      if (!parsedEntry.ok) return { success: false, error: '该服务器的配置无效' }
      return { success: true, config: toConfigView(parsedEntry.config) }
    } catch {
      return { success: false, error: 'MCP 配置损坏或无法读取' }
    }
  }

  /**
   * 新增或覆盖一个服务器：校验 → 原子写盘 → 重新加载（会断开配置已变化的连接）。
   */
  async saveServer(request: MCPServerSaveRequest): Promise<{ success: boolean; error?: string }> {
    if (!request || typeof request.id !== 'string' || !request.id.trim()) {
      return { success: false, error: '服务器 ID 不能为空' }
    }
    const id = request.id.trim()
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      return { success: false, error: '服务器 ID 只能包含字母、数字、点、下划线与短横线' }
    }
    const parsedEntry = parseServerEntry(id, {
      command: request.command,
      args: request.args,
      env: request.env,
      url: request.url,
      disabled: request.disabled,
    })
    if (!parsedEntry.ok) {
      return { success: false, error: '配置无效：stdio 需要非空命令，SSE 需要非空 URL，二者只能填一个' }
    }

    let config: MCPConfig
    try {
      config = await this.readConfigObject() ?? { mcpServers: {} }
    } catch {
      return { success: false, error: 'MCP 配置损坏，无法保存。请先修复或删除该文件' }
    }
    config.mcpServers[id] = serializeServerEntry(parsedEntry.config)
    try {
      writeJsonFile(this.getDefaultConfigPath(), config)
    } catch (error) {
      logFailure('MCP', 'save server config failed', error, { serverId: id })
      return { success: false, error: '写入配置文件失败' }
    }
    const reload = await this.loadConfig()
    if (reload.status === 'error') {
      return { success: false, error: '配置已写入，但重新加载失败' }
    }
    return { success: true }
  }

  /**
   * 删除一个服务器：原子写盘 → 断开其连接 → 重新加载。
   */
  async deleteServer(serverId: string): Promise<{ success: boolean; error?: string }> {
    if (!serverId || typeof serverId !== 'string') return { success: false, error: '服务器 ID 无效' }
    let config: MCPConfig | null
    try {
      config = await this.readConfigObject()
    } catch {
      return { success: false, error: 'MCP 配置损坏或无法读取' }
    }
    if (!config || !Object.hasOwn(config.mcpServers, serverId)) {
      return { success: false, error: '未找到该服务器' }
    }
    delete config.mcpServers[serverId]
    try {
      writeJsonFile(this.getDefaultConfigPath(), config)
    } catch (error) {
      logFailure('MCP', 'delete server config failed', error, { serverId })
      return { success: false, error: '写入配置文件失败' }
    }
    await this.disconnect(serverId)
    await this.loadConfig()
    return { success: true }
  }

  /**
   * 局部更新一个服务器：未提供的字段保留原值，提供的字段整体替换。
   *
   * 切换传输方式时把另一侧字段显式传空字符串清掉（如 url: '' 切回 stdio）。
   * 校验、写盘与重新加载仍走同一条 Seam。
   */
  async updateServer(
    serverId: string,
    patch: { command?: string; args?: string[]; env?: Record<string, string>; url?: string; disabled?: boolean },
  ): Promise<{ success: boolean; error?: string }> {
    if (!serverId || typeof serverId !== 'string') return { success: false, error: '服务器 ID 无效' }
    let config: MCPConfig | null
    try {
      config = await this.readConfigObject()
    } catch {
      return { success: false, error: 'MCP 配置损坏或无法读取' }
    }
    if (!config || !Object.hasOwn(config.mcpServers, serverId)) {
      return { success: false, error: '未找到该服务器' }
    }
    const existing = parseServerEntry(serverId, config.mcpServers[serverId])
    if (!existing.ok) return { success: false, error: '该服务器的现有配置无效，请先修复' }

    const merged: MCPConfig['mcpServers'][string] = {
      command: patch.command !== undefined ? patch.command : existing.config.command,
      args: patch.args !== undefined ? patch.args : existing.config.args,
      env: patch.env !== undefined ? patch.env : existing.config.env,
      url: patch.url !== undefined ? patch.url : existing.config.url,
      disabled: patch.disabled !== undefined ? patch.disabled : existing.config.disabled,
    }
    const validated = parseServerEntry(serverId, merged)
    if (!validated.ok) {
      return {
        success: false,
        error: '合并后的配置无效：stdio 需要非空命令，SSE 需要非空 URL，二者只能填一个。切换传输方式时请把另一侧字段显式传空字符串',
      }
    }
    config.mcpServers[serverId] = serializeServerEntry(validated.config)
    try {
      writeJsonFile(this.getDefaultConfigPath(), config)
    } catch (error) {
      logFailure('MCP', 'update server config failed', error, { serverId })
      return { success: false, error: '写入配置文件失败' }
    }
    const reload = await this.loadConfig()
    if (reload.status === 'error') {
      return { success: false, error: '配置已写入，但重新加载失败' }
    }
    return { success: true }
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
    } catch (error) {
      logFailure('MCP', 'server connect failed', error, { serverId: config.id, transport: config.transport })
      await runtime.session?.close().catch((closeError) => {
        logFailure('MCP', 'session close after connect failure also failed', closeError, { serverId: config.id })
      })
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
    } catch (error) {
      logFailure('MCP', 'tools/list failed', error, { serverId: runtime.config.id })
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
    } catch (error) {
      logFailure('MCP', 'resources/list failed', error, { serverId: runtime.config.id })
      runtime.resources = []
    }
  }

  /**
   * 调用 MCP Tool
   */
  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<MCPCallToolResult> {
    const runtime = this.servers.get(serverId)
    if (!runtime || runtime.status !== 'connected') {
      return { success: false, content: '', error: `服务器 ${serverId} 未连接` }
    }

    try {
      const result = await runtime.session!.callTool(toolName, args)
      const textParts: string[] = []
      const items: MCPContentBlock[] = []
      for (const c of (result.content ?? [])) {
        if (c.type === 'text') {
          const text = c.text ?? ''
          textParts.push(text)
          items.push({ type: 'text', text })
        } else if (c.type === 'image') {
          const rec = c as Record<string, unknown>
          const data = typeof rec.data === 'string' ? rec.data : ''
          const mimeType = typeof rec.mimeType === 'string' ? rec.mimeType : 'image/png'
          textParts.push(`[Image: ${mimeType}]`)
          if (data) {
            items.push({ type: 'image', data, mimeType })
          }
        } else if (c.type === 'resource') {
          const res = (c as Record<string, unknown>).resource as { uri?: string; text?: string } | undefined
          const text = res?.text ?? `[Resource: ${res?.uri ?? 'unknown'}]`
          textParts.push(text)
          items.push({ type: 'text', text })
        } else {
          textParts.push(`[${c.type}]`)
        }
      }
      return { success: true, content: textParts.filter(Boolean).join('\n'), items }
    } catch (error) {
      logFailure('MCP', 'tools/call failed', error, { serverId, toolName })
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
      if (runtime.status === 'connected' && !runtime.config.disabled) {
        tools.push(...runtime.tools)
      }
    }
    return tools
  }

  /** 获取所有 MCP 资源 */
  getAllResources(): MCPResourceDesc[] {
    const resources: MCPResourceDesc[] = []
    for (const runtime of this.servers.values()) {
      if (runtime.status === 'connected' && !runtime.config.disabled) {
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
      disabled: r.config.disabled,
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
