import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type, type TSchema } from '@earendil-works/pi-ai'

import { mcpManager, type MCPToolDesc } from '../../mcp/mcp-manager'
import { writingLanguageText, type WritingLanguage } from '../../../src/shared/writing-language'

const Schema = Type.Record(Type.String(), Type.Unknown())

export function mcpAgentToolName(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName}`
}

export function createMcpAgentTool(
  desc: MCPToolDesc,
  language: WritingLanguage,
): AgentTool<TSchema> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = desc.description?.trim()
    || text(`MCP 工具 ${desc.name}（${desc.serverId}）`, `MCP tool ${desc.name} (${desc.serverId})`)

  const parameters = (desc.inputSchema && typeof desc.inputSchema === 'object' && Object.keys(desc.inputSchema).length > 0)
    ? desc.inputSchema
    : Schema

  return {
    name: mcpAgentToolName(desc.serverId, desc.name),
    label: desc.name,
    description,
    parameters: parameters as unknown as TSchema,
    execute: async (_id, params) => {
      const result = await mcpManager.callTool(desc.serverId, desc.name, params as Record<string, unknown>)
      if (!result.success) {
        throw new Error(result.error || text('MCP 工具调用失败', 'The MCP tool call failed'))
      }
      const content = result.items && result.items.length > 0
        ? result.items
        : [{ type: 'text' as const, text: result.content }]
      return {
        content,
        details: { serverId: desc.serverId, toolName: desc.name },
      }
    },
  }
}

export function buildMcpAgentTools(language: WritingLanguage): AgentTool<TSchema>[] {
  return mcpManager.getAllTools().map(desc => createMcpAgentTool(desc, language))
}
