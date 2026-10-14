import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type, StringEnum } from '@earendil-works/pi-ai'

import { mcpManager } from '../../mcp/mcp-manager'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

export const MANAGE_MCP_ACTIONS = [
  'list',
  'get',
  'add',
  'update',
  'connect',
  'disconnect',
  'delete',
] as const

export type ManageMcpAction = typeof MANAGE_MCP_ACTIONS[number]

const Schema = Type.Object({
  action: Type.Optional(StringEnum(MANAGE_MCP_ACTIONS, {
    description: 'Operation action: "list" (show all configured servers, default), "get" (read single server config), "add" (add a server), "update" (partially modify server), "connect" (connect server), "disconnect" (disconnect server), "delete" (delete server).',
  })),
  server_id: Type.Optional(Type.String({ description: '目标服务器 ID（get / update / delete 必填）' })),
  command: Type.Optional(Type.String({ description: 'stdio 启动命令，如 npx、node 或可执行文件路径' })),
  args: Type.Optional(Type.Array(Type.String(), { description: 'stdio 命令参数列表，如 ["-y", "some-package"]' })),
  env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'stdio 环境变量键值对' })),
  url: Type.Optional(Type.String({ description: 'SSE 服务器 URL，如 https://example.com/sse' })),
})

/** 列表视图：摘要 + 实时状态，绝不带凭据。 */
async function listServers(language: WritingLanguage): Promise<{ content: Array<{ type: 'text'; text: string }>; details: unknown }> {
  const loaded = await mcpManager.loadConfig()
  if (loaded.status === 'error') {
    throw new Error(writingLanguageText(language, `MCP 配置读取失败：${loaded.error}`, `Could not read the MCP configuration: ${loaded.error}`))
  }
  const statuses = mcpManager.getServersStatus()
  const statusOf = (id: string) => statuses.find(status => status.id === id)
  const rows = loaded.servers.map(summary => {
    const runtime = statusOf(summary.id)
    const state = runtime?.status ?? 'disconnected'
    const toolCount = runtime?.toolCount ?? 0
    return writingLanguageText(
      language,
      `- ${summary.id}（${summary.transport}）· 状态: ${state}${runtime?.status === 'connected' ? ` · 工具: ${toolCount} 个` : ''}`,
      `- ${summary.id} (${summary.transport}) · status: ${state}${runtime?.status === 'connected' ? ` · tools: ${toolCount}` : ''}`,
    )
  })
  const body = rows.length > 0
    ? rows.join('\n')
    : writingLanguageText(language, '（还没有配置任何 MCP 服务器）', '(No MCP servers configured yet)')
  return {
    content: [{ type: 'text', text: `${writingLanguageText(language, '已配置的 MCP 服务器：', 'Configured MCP servers:')}\n${body}` }],
    details: { servers: loaded.servers, statuses },
  }
}

/**
 * MCP 服务器管理工具：项目助手可以查看、添加、修改、删除 MCP 服务器。
 *
 * 增删改走 mcpManager 的原子写盘 + 重新加载，与设置页共用同一条校验 Seam；
 * 写操作始终要求用户在确认卡上点头，查看操作自动放行。
 */
export function createManageMcpTool(
  language: WritingLanguage,
): AgentTool<typeof Schema, unknown> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'Manage MCP servers: list configured servers and their connection state, read one server\'s full configuration, add, partially update (omitted fields keep their values), connect/disconnect, or delete servers. Add/update/delete always require user confirmation.'
    : '管理 MCP 服务器：列出已配置服务器及连接状态、读取单个服务器完整配置、添加、局部修改（未提供的字段保留原值）、连接/断开或删除服务器。增删改始终需要用户确认。'

  return {
    name: 'manage_mcp',
    label: 'Manage MCP',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const action = (params.action ?? 'list') as ManageMcpAction
      switch (action) {
        case 'list': {
          return listServers(language)
        }
        case 'get': {
          if (!params.server_id) throw new Error(text('缺少 server_id 参数', 'The server_id argument is required'))
          const result = await mcpManager.getServerConfig(params.server_id)
          if (!result.success) throw new Error(result.error)
          return {
            content: [{ type: 'text', text: JSON.stringify(result.config, null, 2) }],
            details: { config: result.config },
          }
        }
        case 'add': {
          if (!params.server_id || !params.server_id.trim()) {
            throw new Error(text('缺少 server_id 参数', 'The server_id argument is required'))
          }
          const saved = await mcpManager.saveServer({
            id: params.server_id,
            command: params.command,
            args: params.args,
            env: params.env,
            url: params.url,
          })
          if (!saved.success) throw new Error(saved.error ?? text('保存失败', 'Save failed'))
          // 保存成功后立刻尝试连接，让新工具尽早可用；连接失败不影响保存结果。
          let connected = true
          let connectError = ''
          try {
            await mcpManager.connect(params.server_id)
          } catch (error) {
            connected = false
            connectError = error instanceof Error ? error.message : String(error)
          }
          const status = mcpManager.getServersStatus().find(entry => entry.id === params.server_id)
          const summary = connected
            ? text(
              `服务器「${params.server_id}」已添加并连接成功，获得 ${status?.toolCount ?? 0} 个工具。`,
              `Server “${params.server_id}” was added and connected with ${status?.toolCount ?? 0} tools.`,
            )
            : text(
              `服务器「${params.server_id}」已添加，但连接失败：${connectError}`,
              `Server “${params.server_id}” was added, but connecting failed: ${connectError}`,
            )
          return {
            content: [{ type: 'text', text: summary }],
            details: { id: params.server_id, connected, status },
          }
        }
        case 'update': {
          if (!params.server_id || !params.server_id.trim()) {
            throw new Error(text('缺少 server_id 参数', 'The server_id argument is required'))
          }
          const updated = await mcpManager.updateServer(params.server_id, {
            command: params.command,
            args: params.args,
            env: params.env,
            url: params.url,
          })
          if (!updated.success) throw new Error(updated.error ?? text('更新失败', 'Update failed'))
          // 局部更新成功后自动重连，让改动立刻生效；连接失败不影响配置保存结果。
          let connected = true
          let connectError = ''
          try {
            await mcpManager.connect(params.server_id)
          } catch (error) {
            connected = false
            connectError = error instanceof Error ? error.message : String(error)
          }
          const status = mcpManager.getServersStatus().find(entry => entry.id === params.server_id)
          const summary = connected
            ? text(
              `服务器「${params.server_id}」已更新并重连成功，获得 ${status?.toolCount ?? 0} 个工具。`,
              `Server “${params.server_id}” was updated and reconnected with ${status?.toolCount ?? 0} tools.`,
            )
            : text(
              `服务器「${params.server_id}」已更新，但重连失败：${connectError}`,
              `Server “${params.server_id}” was updated, but reconnecting failed: ${connectError}`,
            )
          return {
            content: [{ type: 'text', text: summary }],
            details: { id: params.server_id, connected, status },
          }
        }
        case 'connect': {
          if (!params.server_id) throw new Error(text('缺少 server_id 参数', 'The server_id argument is required'))
          await mcpManager.connect(params.server_id)
          const status = mcpManager.getServersStatus().find(entry => entry.id === params.server_id)
          return {
            content: [{ type: 'text', text: text(
              `服务器「${params.server_id}」已连接，获得 ${status?.toolCount ?? 0} 个工具。`,
              `Server “${params.server_id}” is connected with ${status?.toolCount ?? 0} tools.`,
            ) }],
            details: { id: params.server_id, status },
          }
        }
        case 'disconnect': {
          if (!params.server_id) throw new Error(text('缺少 server_id 参数', 'The server_id argument is required'))
          await mcpManager.disconnect(params.server_id)
          return {
            content: [{ type: 'text', text: text(
              `服务器「${params.server_id}」已断开，配置保留，可随时重新连接。`,
              `Server “${params.server_id}” is disconnected. Its configuration is kept and it can be reconnected anytime.`,
            ) }],
            details: { id: params.server_id },
          }
        }
        case 'delete': {
          if (!params.server_id) throw new Error(text('缺少 server_id 参数', 'The server_id argument is required'))
          const deleted = await mcpManager.deleteServer(params.server_id)
          if (!deleted.success) throw new Error(deleted.error ?? text('删除失败', 'Delete failed'))
          return {
            content: [{ type: 'text', text: text(
              `服务器「${params.server_id}」已删除，其连接已断开。`,
              `Server “${params.server_id}” was deleted and disconnected.`,
            ) }],
            details: { id: params.server_id },
          }
        }
        default: {
          throw new Error(text('未知操作', 'Unknown action'))
        }
      }
    },
  }
}
