import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const CONNECT_TIMEOUT_MS = 10_000

export interface McpTransportConfig {
  transport: 'stdio' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
}

export interface McpSdkSession {
  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }>
  listResources(): Promise<{ resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }> }>
  callTool(name: string, args: Record<string, unknown>): Promise<{ content?: Array<{ type: string; text?: string }> }>
  close(): Promise<void>
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

/** Open an official MCP SDK client for stdio or SSE. */
export async function openMcpSdkSession(config: McpTransportConfig): Promise<McpSdkSession> {
  const client = new Client({ name: 'vela', version: '1.0.0' })
  const transport = config.transport === 'sse'
    ? new SSEClientTransport(new URL(config.url ?? ''))
    : new StdioClientTransport({
        command: config.command ?? '',
        args: config.args,
        env: { ...process.env, ...config.env } as Record<string, string>,
      })
  await withTimeout(client.connect(transport), 'initialize')
  return {
    listTools: () => client.listTools(),
    listResources: () => client.listResources(),
    callTool: async (name, args) => {
      const result = await client.callTool({ name, arguments: args })
      const content = 'content' in result && Array.isArray(result.content) ? result.content : []
      return { content }
    },
    close: () => client.close(),
  }
}
