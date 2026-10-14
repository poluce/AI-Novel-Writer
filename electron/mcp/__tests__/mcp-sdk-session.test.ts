import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openMcpSdkSession } from '../mcp-sdk-session'

const mockConnect = vi.fn()
const mockListTools = vi.fn().mockResolvedValue({ tools: [{ name: 'test_tool' }] })
const mockListResources = vi.fn().mockResolvedValue({ resources: [] })
const mockCallTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'result' }] })
const mockClose = vi.fn().mockResolvedValue(undefined)

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: class MockClient {
      connect = mockConnect
      listTools = mockListTools
      listResources = mockListResources
      callTool = mockCallTool
      close = mockClose
    },
  }
})

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class MockSSETransport {
    constructor(public url: unknown) {}
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class MockStdioTransport {
    constructor(public opts: unknown) {}
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTPTransport {
    constructor(public url: unknown) {}
  },
}))

describe('openMcpSdkSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('connects via stdio transport', async () => {
    mockConnect.mockResolvedValue(undefined)
    const session = await openMcpSdkSession({
      transport: 'stdio',
      command: 'node',
      args: ['index.js'],
    })

    expect(mockConnect).toHaveBeenCalledTimes(1)
    const tools = await session.listTools()
    expect(tools.tools).toHaveLength(1)
  })

  it('connects via streamable-http directly', async () => {
    mockConnect.mockResolvedValue(undefined)
    const session = await openMcpSdkSession({
      transport: 'streamable-http',
      url: 'https://api.example.com/mcp',
    })

    expect(mockConnect).toHaveBeenCalledTimes(1)
    const tools = await session.listTools()
    expect(tools.tools[0].name).toBe('test_tool')
  })

  it('connects via SSE when successful', async () => {
    mockConnect.mockResolvedValue(undefined)
    const session = await openMcpSdkSession({
      transport: 'sse',
      url: 'https://api.example.com/sse',
    })

    expect(mockConnect).toHaveBeenCalledTimes(1)
    const tools = await session.listTools()
    expect(tools.tools[0].name).toBe('test_tool')
  })

  it('automatically falls back to StreamableHTTPClientTransport when SSE returns 405', async () => {
    // First connection attempt (SSE) fails with 405
    mockConnect
      .mockRejectedValueOnce(new Error('SSE error: Non-200 status code (405)'))
      .mockResolvedValueOnce(undefined) // Second attempt (StreamableHTTP) succeeds

    const session = await openMcpSdkSession({
      transport: 'sse',
      url: 'https://api.anysearch.com/mcp',
    })

    // Connect was called twice (SSE then StreamableHTTP fallback)
    expect(mockConnect).toHaveBeenCalledTimes(2)
    const tools = await session.listTools()
    expect(tools.tools[0].name).toBe('test_tool')
  })

  it('propagates other non-405 errors from SSE connection', async () => {
    mockConnect.mockRejectedValueOnce(new Error('Connection refused (ECONNREFUSED)'))

    await expect(openMcpSdkSession({
      transport: 'sse',
      url: 'https://api.example.com/sse',
    })).rejects.toThrow('Connection refused')
  })
})
