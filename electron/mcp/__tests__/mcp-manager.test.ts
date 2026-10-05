import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const openSessionMock = vi.hoisted(() => vi.fn())

vi.mock('../mcp-sdk-session', () => ({
  openMcpSdkSession: (...args: unknown[]) => openSessionMock(...args),
}))
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => 'C:/REAL-HOME-MUST-NOT-BE-READ') } }))

type Manager = typeof import('../mcp-manager')['mcpManager']

let velaHome = ''
let mcpManager: Manager

function fakeSession() {
  const close = vi.fn(async () => {})
  return {
    listTools: vi.fn(async () => ({ tools: [] })),
    listResources: vi.fn(async () => ({ resources: [] })),
    callTool: vi.fn(async () => ({ content: [] })),
    close,
  }
}

function writeConfig(value: unknown): void {
  fs.writeFileSync(
    path.join(velaHome, 'mcp_config.json'),
    typeof value === 'string' ? value : JSON.stringify(value),
    'utf8',
  )
}

beforeEach(async () => {
  vi.resetModules()
  openSessionMock.mockReset()
  velaHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-mcp-'))
  process.env.AI_NOVEL_VELA_HOME = velaHome
  mcpManager = (await import('../mcp-manager')).mcpManager
})

afterEach(async () => {
  vi.useRealTimers()
  await mcpManager.disconnectAll()
  delete process.env.AI_NOVEL_VELA_HOME
  fs.rmSync(velaHome, { recursive: true, force: true })
})

describe('MCP trusted configuration boundary', () => {
  it('uses the isolated VELA_HOME and distinguishes a missing config', async () => {
    expect(mcpManager.getDefaultConfigPath()).toBe(path.join(velaHome, 'mcp_config.json'))
    await expect(mcpManager.loadConfig()).resolves.toEqual({ status: 'missing', servers: [] })
    expect(openSessionMock).not.toHaveBeenCalled()
  })

  it('revokes previously trusted ids when a reload is missing or corrupt', async () => {
    writeConfig({ mcpServers: { old_server: { command: 'node' } } })
    await expect(mcpManager.loadConfig()).resolves.toMatchObject({ status: 'loaded' })
    fs.unlinkSync(path.join(velaHome, 'mcp_config.json'))

    await expect(mcpManager.loadConfig()).resolves.toEqual({ status: 'missing', servers: [] })
    await expect(mcpManager.connect('old_server')).rejects.toThrow(/未配置/u)

    writeConfig({ mcpServers: { old_server: { command: 'node' } } })
    await expect(mcpManager.loadConfig()).resolves.toMatchObject({ status: 'loaded' })
    writeConfig('{BROKEN_MCP_CONFIG')

    await expect(mcpManager.loadConfig()).resolves.toMatchObject({ status: 'error', servers: [] })
    await expect(mcpManager.connect('old_server')).rejects.toThrow(/未配置/u)
  })

  it('disconnects an active server when its configuration becomes missing', async () => {
    writeConfig({ mcpServers: { old_server: { command: 'node' } } })
    const session = fakeSession()
    openSessionMock.mockResolvedValue(session)
    await mcpManager.loadConfig()
    await mcpManager.connect('old_server')
    fs.unlinkSync(path.join(velaHome, 'mcp_config.json'))

    await expect(mcpManager.loadConfig()).resolves.toEqual({ status: 'missing', servers: [] })

    expect(session.close).toHaveBeenCalledOnce()
    expect(mcpManager.getServersStatus()).toEqual([])
  })

  it('disconnects an active server when its configuration becomes corrupt', async () => {
    writeConfig({ mcpServers: { old_server: { command: 'node' } } })
    const session = fakeSession()
    openSessionMock.mockResolvedValue(session)
    await mcpManager.loadConfig()
    await mcpManager.connect('old_server')
    writeConfig('{BROKEN_MCP_CONFIG')

    await expect(mcpManager.loadConfig()).resolves.toMatchObject({ status: 'error', servers: [] })

    expect(session.close).toHaveBeenCalledOnce()
    expect(mcpManager.getServersStatus()).toEqual([])
  })

  it('keeps unchanged connections and disconnects deleted or changed servers on reload', async () => {
    writeConfig({
      mcpServers: {
        unchanged: { command: 'node', args: ['same.js'] },
        changed: { command: 'node', args: ['old.js'] },
        deleted: { command: 'node', args: ['gone.js'] },
      },
    })
    const unchanged = fakeSession()
    const changed = fakeSession()
    const deleted = fakeSession()
    openSessionMock
      .mockResolvedValueOnce(unchanged)
      .mockResolvedValueOnce(changed)
      .mockResolvedValueOnce(deleted)
    await mcpManager.loadConfig()
    await mcpManager.connect('unchanged')
    await mcpManager.connect('changed')
    await mcpManager.connect('deleted')

    writeConfig({
      mcpServers: {
        unchanged: { command: 'node', args: ['same.js'] },
        changed: { command: 'node', args: ['new.js'] },
        added: { command: 'node', args: ['new-server.js'] },
      },
    })
    await mcpManager.loadConfig()

    expect(unchanged.close).not.toHaveBeenCalled()
    expect(changed.close).toHaveBeenCalledOnce()
    expect(deleted.close).toHaveBeenCalledOnce()
    expect(mcpManager.getServersStatus().map(server => server.id)).toEqual(['unchanged'])
  })

  it('reports a malformed config instead of treating it as missing', async () => {
    writeConfig({
      mcpServers: {
        appears_before_damage: { command: 'node' },
        damaged: { args: 'not-an-array' },
      },
    })
    await expect(mcpManager.loadConfig()).resolves.toEqual({
      status: 'error',
      servers: [],
      error: expect.stringMatching(/MCP.*配置.*损坏/u),
    })
    await expect(mcpManager.connect('appears_before_damage')).rejects.toThrow(/未配置/u)
  })

  it('reports invalid JSON as corrupt configuration', async () => {
    writeConfig('{BROKEN_MCP_CONFIG')
    await expect(mcpManager.loadConfig()).resolves.toEqual({
      status: 'error',
      servers: [],
      error: expect.stringMatching(/MCP.*配置.*损坏/u),
    })
  })

  it.each([
    { serverConfig: {}, caseName: 'neither transport' },
    { serverConfig: { command: 'node', url: 'https://example.invalid/sse' }, caseName: 'ambiguous transport' },
    { serverConfig: { command: '   ' }, caseName: 'blank command' },
    { serverConfig: { url: '   ' }, caseName: 'blank URL' },
  ])('rejects $caseName instead of loading an unusable server', async ({ serverConfig }) => {
    writeConfig({ mcpServers: { invalid: serverConfig } })
    await expect(mcpManager.loadConfig()).resolves.toMatchObject({ status: 'error', servers: [] })
    await expect(mcpManager.connect('invalid')).rejects.toThrow(/未配置/u)
  })

  it('keeps command arguments, environment, and credential URLs in the main process', async () => {
    writeConfig({
      mcpServers: {
        secret_stdio_server: {
          command: 'SECRET_COMMAND_MARKER',
          args: ['SECRET_ARGUMENT_MARKER'],
          env: { API_KEY: 'SECRET_ENV_MARKER' },
        },
        secret_sse_server: {
          url: 'https://user:SECRET_URL_MARKER@example.invalid/sse',
        },
      },
    })

    const result = await mcpManager.loadConfig()

    expect(result).toEqual({
      status: 'loaded',
      servers: [
        { id: 'secret_stdio_server', name: 'secret_stdio_server', transport: 'stdio' },
        { id: 'secret_sse_server', name: 'secret_sse_server', transport: 'sse' },
      ],
    })
    expect(JSON.stringify(result)).not.toMatch(/SECRET_(?:COMMAND|ARGUMENT|ENV|URL)_MARKER/u)
  })

  it('rejects an id that was not loaded from the trusted config', async () => {
    await expect(mcpManager.connect('unconfigured')).rejects.toThrow(/未配置/u)
    expect(openSessionMock).not.toHaveBeenCalled()
  })

  it('connects a loaded stdio server through the official SDK', async () => {
    writeConfig({
      mcpServers: {
        hidden_window_test: {
          command: 'node',
          args: ['server.js'],
          env: { MCP_TEST: '1' },
        },
      },
    })
    openSessionMock.mockResolvedValue(fakeSession())
    await mcpManager.loadConfig()

    await mcpManager.connect('hidden_window_test')

    expect(openSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'hidden_window_test',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { MCP_TEST: '1' },
    }))
  })

  it('connects a loaded SSE server through the official SDK', async () => {
    writeConfig({ mcpServers: { remote: { url: 'https://example.invalid/sse' } } })
    openSessionMock.mockResolvedValue(fakeSession())
    await mcpManager.loadConfig()

    await mcpManager.connect('remote')

    expect(openSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      transport: 'sse',
      url: 'https://example.invalid/sse',
    }))
  })

  it('rejects when MCP session initialization fails and preserves an error status', async () => {
    writeConfig({ mcpServers: { broken: { command: 'node' } } })
    openSessionMock.mockRejectedValue(new Error('SECRET_INITIALIZE_ERROR_MARKER'))
    await mcpManager.loadConfig()

    await expect(mcpManager.connect('broken')).rejects.toThrow(/MCP.*连接失败/u)
    expect(mcpManager.getServersStatus()).toEqual([
      expect.objectContaining({ id: 'broken', status: 'error', error: expect.stringMatching(/MCP.*连接失败/u) }),
    ])
    expect(JSON.stringify(mcpManager.getServersStatus())).not.toContain('SECRET_INITIALIZE_ERROR_MARKER')
  })

  it('settles once with a safe error when the child process fails to start', async () => {
    writeConfig({ mcpServers: { broken: { command: 'node' } } })
    openSessionMock.mockRejectedValue(new Error('SECRET_CHILD_ERROR_MARKER'))
    await mcpManager.loadConfig()

    await expect(mcpManager.connect('broken')).rejects.toThrow(/MCP.*连接失败/u)
    expect(mcpManager.getServersStatus()).toEqual([
      expect.objectContaining({ id: 'broken', status: 'error', error: 'MCP 服务器连接失败' }),
    ])
    expect(JSON.stringify(mcpManager.getServersStatus())).not.toContain('SECRET_CHILD_ERROR_MARKER')
  })

  it('times out initialization without leaving the connection pending', async () => {
    vi.useFakeTimers()
    writeConfig({ mcpServers: { silent: { command: 'node' } } })
    openSessionMock.mockImplementation(() => new Promise(() => {}))
    await mcpManager.loadConfig()

    const rejection = expect(mcpManager.connect('silent')).rejects.toThrow(/MCP.*连接失败/u)
    await vi.advanceTimersByTimeAsync(10_000)
    await rejection
    expect(mcpManager.getServersStatus()).toEqual([
      expect.objectContaining({ id: 'silent', status: 'error' }),
    ])
  })
})

describe('MCP server management (settings page)', () => {
  function readConfigFile(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(velaHome, 'mcp_config.json'), 'utf8'))
  }

  it('creates a new server into a missing config file and reloads the trusted list', async () => {
    await expect(mcpManager.saveServer({ id: 'new_stdio', command: 'node', args: ['server.js'] }))
      .resolves.toEqual({ success: true })

    expect(readConfigFile()).toEqual({
      mcpServers: { new_stdio: { command: 'node', args: ['server.js'] } },
    })
    await expect(mcpManager.loadConfig()).resolves.toMatchObject({
      status: 'loaded',
      servers: [{ id: 'new_stdio', name: 'new_stdio', transport: 'stdio' }],
    })
  })

  it('creates an SSE server with its URL and nothing else', async () => {
    await mcpManager.saveServer({ id: 'remote', url: 'https://example.invalid/sse' })

    expect(readConfigFile()).toEqual({
      mcpServers: { remote: { url: 'https://example.invalid/sse' } },
    })
  })

  it('updates an existing server without touching the other entries', async () => {
    writeConfig({
      mcpServers: {
        keep: { command: 'node', args: ['keep.js'] },
        update_me: { command: 'node', args: ['old.js'] },
      },
    })
    await mcpManager.loadConfig()

    await expect(mcpManager.saveServer({
      id: 'update_me',
      command: 'npx',
      args: ['new.js', '--flag'],
      env: { API_KEY: 'VALUE' },
    })).resolves.toEqual({ success: true })

    expect(readConfigFile()).toEqual({
      mcpServers: {
        keep: { command: 'node', args: ['keep.js'] },
        update_me: { command: 'npx', args: ['new.js', '--flag'], env: { API_KEY: 'VALUE' } },
      },
    })
  })

  it('returns one full configuration on demand for editing', async () => {
    writeConfig({
      mcpServers: {
        secret_stdio: { command: 'node', args: ['a.js'], env: { K: 'V' } },
        secret_sse: { url: 'https://user:pass@example.invalid/sse' },
      },
    })
    await mcpManager.loadConfig()

    await expect(mcpManager.getServerConfig('secret_stdio')).resolves.toEqual({
      success: true,
      config: {
        id: 'secret_stdio',
        transport: 'stdio',
        command: 'node',
        args: ['a.js'],
        env: { K: 'V' },
      },
    })
    await expect(mcpManager.getServerConfig('secret_sse')).resolves.toMatchObject({
      success: true,
      config: { transport: 'sse', url: 'https://user:pass@example.invalid/sse' },
    })
    await expect(mcpManager.getServerConfig('missing')).resolves.toMatchObject({ success: false })
    await expect(mcpManager.getServerConfig('')).resolves.toMatchObject({ success: false })
  })

  it('rejects invalid saves without touching the file', async () => {
    writeConfig({ mcpServers: { keep: { command: 'node' } } })
    await mcpManager.loadConfig()
    const before = fs.readFileSync(path.join(velaHome, 'mcp_config.json'), 'utf8')

    await expect(mcpManager.saveServer({ id: 'bad id', command: 'node' }))
      .resolves.toMatchObject({ success: false })
    await expect(mcpManager.saveServer({ id: 'both', command: 'node', url: 'https://example.invalid/sse' }))
      .resolves.toMatchObject({ success: false })
    await expect(mcpManager.saveServer({ id: 'neither' }))
      .resolves.toMatchObject({ success: false })
    await expect(mcpManager.saveServer({ id: 'blank-command', command: '   ' }))
      .resolves.toMatchObject({ success: false })
    await expect(mcpManager.saveServer({ id: 'bad-args', command: 'node', args: ['ok', 3] as never }))
      .resolves.toMatchObject({ success: false })

    expect(fs.readFileSync(path.join(velaHome, 'mcp_config.json'), 'utf8')).toBe(before)
  })

  it('deletes a server, closes its connection, and removes it from disk', async () => {
    writeConfig({ mcpServers: { doomed: { command: 'node' }, stays: { command: 'node' } } })
    const session = fakeSession()
    openSessionMock.mockResolvedValue(session)
    await mcpManager.loadConfig()
    await mcpManager.connect('doomed')

    await expect(mcpManager.deleteServer('doomed')).resolves.toEqual({ success: true })

    expect(session.close).toHaveBeenCalledOnce()
    expect(mcpManager.getServersStatus()).toEqual([])
    expect(readConfigFile()).toEqual({ mcpServers: { stays: { command: 'node' } } })
    await expect(mcpManager.deleteServer('doomed')).resolves.toMatchObject({ success: false })
  })

  it('refuses to delete from a missing or corrupt config', async () => {
    await expect(mcpManager.deleteServer('x')).resolves.toMatchObject({ success: false })
    writeConfig('{BROKEN_MCP_CONFIG')
    await expect(mcpManager.deleteServer('x')).resolves.toMatchObject({ success: false })
  })

  it('partially updates a server and keeps the fields it did not touch', async () => {
    writeConfig({
      mcpServers: {
        docs: { command: 'node', args: ['old.js'], env: { K: 'V' } },
      },
    })
    await mcpManager.loadConfig()

    await expect(mcpManager.updateServer('docs', { command: 'npx' })).resolves.toEqual({ success: true })

    expect(readConfigFile()).toEqual({
      mcpServers: { docs: { command: 'npx', args: ['old.js'], env: { K: 'V' } } },
    })
  })

  it('switches transport when the other side is explicitly cleared', async () => {
    writeConfig({ mcpServers: { remote: { url: 'https://example.invalid/sse' } } })
    await mcpManager.loadConfig()

    await expect(mcpManager.updateServer('remote', { url: '', command: 'node', args: ['s.js'] }))
      .resolves.toEqual({ success: true })

    expect(readConfigFile()).toEqual({
      mcpServers: { remote: { command: 'node', args: ['s.js'] } },
    })
  })

  it('rejects a partial update that would leave both transports configured', async () => {
    writeConfig({ mcpServers: { docs: { command: 'node' } } })
    await mcpManager.loadConfig()

    await expect(mcpManager.updateServer('docs', { url: 'https://example.invalid/sse' }))
      .resolves.toMatchObject({ success: false })

    // 合并失败不得触碰磁盘。
    expect(readConfigFile()).toEqual({ mcpServers: { docs: { command: 'node' } } })
  })

  it('rejects a partial update for an unknown server', async () => {
    writeConfig({ mcpServers: { docs: { command: 'node' } } })
    await mcpManager.loadConfig()

    await expect(mcpManager.updateServer('missing', { command: 'npx' }))
      .resolves.toMatchObject({ success: false })
  })
})
