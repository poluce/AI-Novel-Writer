/**
 * MCP IPC 桥接
 *
 * 在 Electron 主进程注册 MCP 相关的 IPC 处理器，
 * 让渲染进程能够通过 IPC 管理和调用 MCP 服务器。
 */

import { ipcMain, BrowserWindow } from 'electron'
import { mcpManager } from './mcp-manager'
import { logFailure } from '../../src/shared/fail-log'

/** 配置发生增删改后推给渲染层，让设置页与 Agent 面板的 MCP 列表实时同步。 */
function notifyConfigChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('mcp:config-changed')
  }
}

/**
 * 注册所有 MCP IPC 处理器
 * 在 main.ts 中调用
 */
export function registerMCPHandlers(): void {
  // 加载配置文件
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

  // 连接服务器
  ipcMain.handle('mcp:connect', async (_event, serverId: string) => {
    try {
      await mcpManager.connect(serverId)
      return { success: true }
    } catch (error) {
      logFailure('MCP', 'connect IPC failed', error, { serverId })
      return { success: false, error: 'MCP 服务器连接失败' }
    }
  })

  // 断开服务器
  ipcMain.handle('mcp:disconnect', async (_event, serverId: string) => {
    try {
      await mcpManager.disconnect(serverId)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // 断开所有
  ipcMain.handle('mcp:disconnect-all', async () => {
    try {
      await mcpManager.disconnectAll()
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // 获取所有可用 Tool
  ipcMain.handle('mcp:list-tools', async () => {
    return mcpManager.getAllTools()
  })

  // 获取所有可用资源
  ipcMain.handle('mcp:list-resources', async () => {
    return mcpManager.getAllResources()
  })

  // 获取服务器状态
  ipcMain.handle('mcp:get-servers-status', async () => {
    return mcpManager.getServersStatus()
  })

  // 获取默认配置文件路径
  ipcMain.handle('mcp:get-config-path', async () => {
    return mcpManager.getDefaultConfigPath()
  })

  // 按需读取单个服务器的完整配置（设置页编辑用）
  ipcMain.handle('mcp:get-server-config', async (_event, serverId: unknown) => {
    try {
      return await mcpManager.getServerConfig(typeof serverId === 'string' ? serverId : '')
    } catch (error) {
      logFailure('MCP', 'get-server-config IPC failed', error, { serverId: String(serverId) })
      return { success: false, error: 'MCP 服务器配置读取失败' }
    }
  })

  // 新增或覆盖一个服务器
  ipcMain.handle('mcp:save-server', async (_event, request: unknown) => {
    try {
      const payload = request && typeof request === 'object' && !Array.isArray(request)
        ? request as Record<string, unknown>
        : {}
      const result = await mcpManager.saveServer({
        id: typeof payload.id === 'string' ? payload.id : '',
        command: typeof payload.command === 'string' ? payload.command : undefined,
        // 非法类型原样交给管理器拒绝，不在这里静默丢弃。
        args: Array.isArray(payload.args) ? payload.args as string[] : undefined,
        env: payload.env && typeof payload.env === 'object' && !Array.isArray(payload.env)
          ? payload.env as Record<string, string>
          : undefined,
        url: typeof payload.url === 'string' ? payload.url : undefined,
      })
      if (result.success) notifyConfigChanged()
      return result
    } catch (error) {
      logFailure('MCP', 'save-server IPC failed', error)
      return { success: false, error: 'MCP 服务器保存失败' }
    }
  })

  // 删除一个服务器
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

  console.log('[MCP] IPC 处理器已注册')
}
