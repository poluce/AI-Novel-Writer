import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const CONNECT_TIMEOUT_MS = 10_000

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

/** Open an official MCP SDK client for stdio, SSE, or Streamable HTTP. */
export async function openMcpSdkSession(config: McpTransportConfig): Promise<McpSdkSession> {
  let client = new Client({ name: 'vela', version: '1.0.0' })

  if (config.transport === 'stdio') {
    const transport = new StdioClientTransport({
      command: config.command ?? '',
      args: config.args,
      env: { ...process.env, ...config.env } as Record<string, string>,
    })
    await withTimeout(client.connect(transport), 'initialize (stdio)')
  } else if (config.transport === 'streamable-http') {
    const transport = new StreamableHTTPClientTransport(new URL(config.url ?? ''))
    await withTimeout(client.connect(transport), 'initialize (streamable-http)')
  } else {
    // transport 为 sse 或默认 URL 模式：
    // 优先尝试标准的 SSEClientTransport；
    // 如果远程服务器返回 405（Method Not Allowed，表明该端点为只接受 POST 的 Streamable HTTP），
    // 自动平滑升级为 StreamableHTTPClientTransport 进行直连。
    const targetUrl = new URL(config.url ?? '')
    try {
      const sseTransport = new SSEClientTransport(targetUrl)
      await withTimeout(client.connect(sseTransport), 'initialize (sse)')
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      if (errorMsg.includes('405') || errorMsg.includes('Non-200 status code (405)')) {
        client = new Client({ name: 'vela', version: '1.0.0' })
        const streamableTransport = new StreamableHTTPClientTransport(targetUrl)
        await withTimeout(client.connect(streamableTransport), 'initialize (streamable-http fallback)')
      } else {
        throw error
      }
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
