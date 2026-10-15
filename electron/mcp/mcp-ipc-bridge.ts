import { ipcMain, BrowserWindow } from 'electron'
import { mcpManager } from './mcp-manager'
import { logFailure } from '../../src/shared/fail-log'

function notifyConfigChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('mcp:config-changed')
  }
}

function asSaveRequest(request: unknown): {
  id: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  disabled?: boolean
} {
  const payload = request && typeof request === 'object' && !Array.isArray(request)
    ? request as Record<string, unknown>
    : {}
  return {
    id: typeof payload.id === 'string' ? payload.id : '',
    command: typeof payload.command === 'string' ? payload.command : undefined,
    args: Array.isArray(payload.args) ? payload.args as string[] : undefined,
    env: payload.env && typeof payload.env === 'object' && !Array.isArray(payload.env)
      ? payload.env as Record<string, string>
      : undefined,
    url: typeof payload.url === 'string' ? payload.url : undefined,
    ...(typeof payload.disabled === 'boolean' ? { disabled: payload.disabled } : {}),
  }
}

export function registerMCPHandlers(): void {
  ipcMain.handle('mcp:load-config', async () => {
    try {
      const result = await mcpManager.loadConfig()
      if (result.status === 'error') return { success: false, ...result }
      return { success: true, ...result }
    } catch (error) {
      logFailure('MCP', 'load-config IPC failed', error)
      return {
        success: false,
        status: 'error' as const,
        servers: [],
        error: 'MCP 配置加载失败',
      }
    }
  })

  ipcMain.handle('mcp:connect', async (_event, serverId: string) => {
    try {
      await mcpManager.connect(serverId)
      return { success: true }
    } catch (error) {
      logFailure('MCP', 'connect IPC failed', error, { serverId })
      return { success: false, error: 'MCP 服务器连接失败' }
    }
  })

  ipcMain.handle('mcp:disconnect', async (_event, serverId: string) => {
    try {
      await mcpManager.disconnect(serverId)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('mcp:disconnect-all', async () => {
    try {
      await mcpManager.disconnectAll()
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('mcp:list-tools', async () => mcpManager.getAllTools())
  ipcMain.handle('mcp:list-resources', async () => mcpManager.getAllResources())
  ipcMain.handle('mcp:get-servers-status', async () => mcpManager.getServersStatus())
  ipcMain.handle('mcp:get-config-path', async () => mcpManager.getDefaultConfigPath())

  ipcMain.handle('mcp:get-server-config', async (_event, serverId: unknown) => {
    try {
      return await mcpManager.getServerConfig(typeof serverId === 'string' ? serverId : '')
    } catch (error) {
      logFailure('MCP', 'get-server-config IPC failed', error, { serverId: String(serverId) })
      return { success: false, error: 'MCP 服务器配置读取失败' }
    }
  })

  ipcMain.handle('mcp:save-server', async (_event, request: unknown) => {
    try {
      const result = await mcpManager.saveServer(asSaveRequest(request))
      if (result.success) notifyConfigChanged()
      return result
    } catch (error) {
      logFailure('MCP', 'save-server IPC failed', error)
      return { success: false, error: 'MCP 服务器保存失败' }
    }
  })

  ipcMain.handle('mcp:delete-server', async (_event, serverId: unknown) => {
    try {
      const result = await mcpManager.deleteServer(typeof serverId === 'string' ? serverId : '')
      if (result.success) notifyConfigChanged()
      return result
    } catch (error) {
      logFailure('MCP', 'delete-server IPC failed', error, { serverId: String(serverId) })
      return { success: false, error: 'MCP 服务器删除失败' }
    }
  })
}
