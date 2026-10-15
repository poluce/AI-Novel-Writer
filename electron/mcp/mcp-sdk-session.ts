import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export interface McpTransportConfig {
  transport: 'stdio' | 'sse' | 'streamable-http'
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

function createClient(): Client {
  return new Client({ name: 'vela', version: '1.0.0' })
}

function isMethodNotAllowed(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('405')
}

/** Open an official MCP SDK client for stdio, SSE, or Streamable HTTP. */
export async function openMcpSdkSession(config: McpTransportConfig): Promise<McpSdkSession> {
  let client = createClient()

  if (config.transport === 'stdio') {
    await client.connect(new StdioClientTransport({
      command: config.command ?? '',
      args: config.args,
      env: { ...process.env, ...config.env } as Record<string, string>,
    }))
  } else if (config.transport === 'streamable-http') {
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url ?? '')))
  } else {
    const targetUrl = new URL(config.url ?? '')
    try {
      await client.connect(new SSEClientTransport(targetUrl))
    } catch (error) {
      if (!isMethodNotAllowed(error)) throw error
      client = createClient()
      await client.connect(new StreamableHTTPClientTransport(targetUrl))
    }
  }

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
