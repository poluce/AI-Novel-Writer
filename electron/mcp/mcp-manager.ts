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

const CONNECT_TIMEOUT_MS = 10_000
const CONFIG_CORRUPT = 'MCP 配置损坏，未加载任何服务器'

export interface MCPServerConfig {
  id: string
  name: string
  transport: 'stdio' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  disabled?: boolean
}

export interface MCPConfig {
  mcpServers: Record<string, {
    command?: string
    args?: string[]
    env?: Record<string, string>
    url?: string
    disabled?: boolean
  }>
}

export type MCPToolDesc = MCPToolDescription
export type MCPResourceDesc = MCPResourceDescription

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

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP 请求超时: ${label}`)), CONNECT_TIMEOUT_MS)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function isMcpConfig(value: unknown): value is MCPConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (!('mcpServers' in value) || !value.mcpServers) return false
  return typeof value.mcpServers === 'object' && !Array.isArray(value.mcpServers)
}

function invalidServerId(serverId: unknown): boolean {
  return !serverId || typeof serverId !== 'string'
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
  if (cfg.command !== undefined && typeof cfg.command !== 'string') return { ok: false }
  if (cfg.args !== undefined && (!Array.isArray(cfg.args) || cfg.args.some(arg => typeof arg !== 'string'))) {
    return { ok: false }
  }
  if (cfg.env !== undefined) {
    const env = cfg.env
    if (!env || typeof env !== 'object' || Array.isArray(env) || Object.values(env).some(entry => typeof entry !== 'string')) {
      return { ok: false }
    }
  }
  if (cfg.url !== undefined && typeof cfg.url !== 'string') return { ok: false }

  const hasCommand = typeof cfg.command === 'string' && cfg.command.trim().length > 0
  const hasUrl = typeof cfg.url === 'string' && cfg.url.trim().length > 0
  if (hasCommand === hasUrl) return { ok: false }

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
      disabled: typeof cfg.disabled === 'boolean' ? cfg.disabled : undefined,
    },
  }
}

function serializeServerEntry(config: MCPServerConfig): MCPConfig['mcpServers'][string] {
  const entry: MCPConfig['mcpServers'][string] = {}
  if (config.transport === 'sse') {
    entry.url = config.url ?? ''
  } else {
    entry.command = config.command ?? ''
    if (config.args && config.args.length > 0) entry.args = config.args
    if (config.env && Object.keys(config.env).length > 0) entry.env = config.env
  }
  if (config.disabled) entry.disabled = true
  return entry
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

class MCPManagerImpl {
  private servers: Map<string, MCPServerRuntime> = new Map()
  private loadedConfigs: Map<string, MCPServerConfig> = new Map()

  getDefaultConfigPath(): string {
    return join(VELA_HOME, 'mcp_config.json')
  }

  async loadConfig(): Promise<MCPConfigLoadResult> {
    this.loadedConfigs.clear()
    try {
      const parsed: unknown = JSON.parse(await readFile(this.getDefaultConfigPath(), 'utf-8'))
      if (!isMcpConfig(parsed)) {
        await this.disconnectAll()
        return { status: 'error', servers: [], error: CONFIG_CORRUPT }
      }

      const servers: MCPServerSummary[] = []
      const trustedConfigs = new Map<string, MCPServerConfig>()
      for (const [id, value] of Object.entries(parsed.mcpServers)) {
        const parsedEntry = parseServerEntry(id, value)
        if (!parsedEntry.ok) {
          await this.disconnectAll()
          return { status: 'error', servers: [], error: CONFIG_CORRUPT }
        }
        trustedConfigs.set(id, parsedEntry.config)
        servers.push({
          id,
          name: id,
          transport: parsedEntry.config.transport,
          disabled: parsedEntry.config.disabled,
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
      await this.disconnectAll()
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { status: 'missing', servers: [] }
      }
      return { status: 'error', servers: [], error: 'MCP 配置损坏或无法读取，未加载任何服务器' }
    }
  }

  private async readConfigObject(): Promise<MCPConfig | null> {
    let raw: string
    try {
      raw = await readFile(this.getDefaultConfigPath(), 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const parsed: unknown = JSON.parse(raw)
    if (!isMcpConfig(parsed)) throw new Error('MCP 配置损坏或无法读取')
    return parsed
  }

  private persistConfig(config: MCPConfig, action: string, serverId: string): { success: true } | { success: false; error: string } {
    try {
      writeJsonFile(this.getDefaultConfigPath(), config)
      return { success: true }
    } catch (error) {
      logFailure('MCP', action, error, { serverId })
      return { success: false, error: '写入配置文件失败' }
    }
  }

  private async reloadAfterWrite(): Promise<{ success: boolean; error?: string }> {
    const reload = await this.loadConfig()
    if (reload.status === 'error') {
      return { success: false, error: '配置已写入，但重新加载失败' }
    }
    return { success: true }
  }

  async getServerConfig(serverId: string): Promise<
    | { success: true; config: MCPServerConfigView }
    | { success: false; error: string }
  > {
    if (invalidServerId(serverId)) return { success: false, error: '服务器 ID 无效' }
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
    const written = this.persistConfig(config, 'save server config failed', id)
    if (!written.success) return written
    return this.reloadAfterWrite()
  }

  async deleteServer(serverId: string): Promise<{ success: boolean; error?: string }> {
    if (invalidServerId(serverId)) return { success: false, error: '服务器 ID 无效' }
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
    const written = this.persistConfig(config, 'delete server config failed', serverId)
    if (!written.success) return written
    await this.disconnect(serverId)
    await this.loadConfig()
    return { success: true }
  }

  async updateServer(
    serverId: string,
    patch: { command?: string; args?: string[]; env?: Record<string, string>; url?: string; disabled?: boolean },
  ): Promise<{ success: boolean; error?: string }> {
    if (invalidServerId(serverId)) return { success: false, error: '服务器 ID 无效' }
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
    const written = this.persistConfig(config, 'update server config failed', serverId)
    if (!written.success) return written
    return this.reloadAfterWrite()
  }

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

    try {
      runtime.session = await withTimeout(openMcpSdkSession(config), 'initialize')
      await this.discoverTools(runtime)
      await this.discoverResources(runtime)
      runtime.status = 'connected'
    } catch (error) {
      logFailure('MCP', 'server connect failed', error, { serverId: config.id, transport: config.transport })
      await runtime.session?.close().catch((closeError) => {
        logFailure('MCP', 'session close after connect failure also failed', closeError, { serverId: config.id })
      })
      runtime.session = undefined
      runtime.status = 'error'
      runtime.error = 'MCP 服务器连接失败'
      throw new Error(runtime.error)
    }
  }

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
          if (data) items.push({ type: 'image', data, mimeType })
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

  async disconnect(serverId: string): Promise<void> {
    const runtime = this.servers.get(serverId)
    if (!runtime) return
    await runtime.session?.close().catch(() => {})
    this.servers.delete(serverId)
  }

  async disconnectAll(): Promise<void> {
    for (const id of this.servers.keys()) {
      await this.disconnect(id)
    }
  }

  private connectedRuntimes(): MCPServerRuntime[] {
    return Array.from(this.servers.values()).filter(runtime => (
      runtime.status === 'connected' && !runtime.config.disabled
    ))
  }

  getAllTools(): MCPToolDesc[] {
    return this.connectedRuntimes().flatMap(runtime => runtime.tools)
  }

  getAllResources(): MCPResourceDesc[] {
    return this.connectedRuntimes().flatMap(runtime => runtime.resources)
  }

  getServersStatus(): MCPServerStatus[] {
    return Array.from(this.servers.values()).map(runtime => ({
      id: runtime.config.id,
      name: runtime.config.name,
      status: runtime.status,
      toolCount: runtime.tools.length,
      error: runtime.error,
      disabled: runtime.config.disabled,
    }))
  }
}

export const mcpManager = new MCPManagerImpl()
