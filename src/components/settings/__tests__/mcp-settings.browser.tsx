import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'

import { useMCPStore } from '../../../stores/mcp-store'
import { useLocaleStore } from '../../../stores/locale-store'
import MCPSettings from '../MCPSettings'

vi.mock('../../ui/Confirm', () => ({
  confirm: vi.fn(async () => true),
}))

const originalMCPState = useMCPStore.getState()
const originalLocaleState = useLocaleStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

const saveServer = vi.fn(async (request: { id: string; command?: string; url?: string }) => {
  useMCPStore.setState(state => ({
    configs: [
      ...state.configs.filter(config => config.id !== request.id),
      { id: request.id, name: request.id, transport: request.url ? 'sse' as const : 'stdio' as const },
    ],
  }))
  return { success: true }
})

const deleteServer = vi.fn(async (serverId: string) => {
  useMCPStore.setState(state => ({
    configs: state.configs.filter(config => config.id !== serverId),
  }))
  return { success: true }
})

beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
  useMCPStore.setState({
    configs: [{ id: 'filesystem', name: 'filesystem', transport: 'stdio' }],
    servers: [{ id: 'filesystem', name: 'filesystem', status: 'connected', toolCount: 2 }],
    tools: [],
    resources: [],
    configPath: 'C:\\Users\\me\\.vela\\mcp_config.json',
    loading: false,
    error: null,
    reloadConfig: vi.fn(async () => {}),
    refreshStatus: vi.fn(async () => {}),
    refreshTools: vi.fn(async () => {}),
    getServerConfig: vi.fn(async (serverId: string) => ({
      success: true,
      config: {
        id: serverId,
        transport: 'stdio' as const,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
        env: {},
      },
    })),
    saveServer,
    deleteServer,
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  saveServer.mockClear()
  deleteServer.mockClear()
  useMCPStore.setState(originalMCPState, true)
  useLocaleStore.setState(originalLocaleState, true)
})

describe('MCP server settings management', () => {
  it('lists configured servers with their connection status and tool count', async () => {
    await act(async () => root?.render(<MCPSettings />))

    await expect.element(page.getByText('filesystem', { exact: true })).toBeVisible()
    await expect.element(page.getByText('已连接 · 2 个工具')).toBeVisible()
    await expect.element(page.getByText('C:\\Users\\me\\.vela\\mcp_config.json')).toBeVisible()
    await expect.element(page.getByRole('button', { name: '断开' })).toBeVisible()
  })

  it('adds a stdio server through the form and saves parsed arguments', async () => {
    await act(async () => root?.render(<MCPSettings />))

    await act(async () => page.getByRole('button', { name: '添加服务器' }).click())
    await expect.element(page.getByLabelText('服务器 ID')).toBeVisible()

    await act(async () => {
      await page.getByLabelText('服务器 ID').fill('new-server')
      await page.getByLabelText('启动命令').fill('npx')
      await page.getByLabelText('命令参数（每行一个）').fill('-y\nsome-package')
    })

    await act(async () => page.getByRole('button', { name: '保存', exact: true }).click())

    await vi.waitFor(() => {
      expect(saveServer).toHaveBeenCalledWith({
        id: 'new-server',
        command: 'npx',
        args: ['-y', 'some-package'],
        env: {},
      })
    })
    await expect.element(page.getByText('new-server', { exact: true })).toBeVisible()
  })

  it('switches to SSE transport and saves a URL', async () => {
    await act(async () => root?.render(<MCPSettings />))

    await act(async () => page.getByRole('button', { name: '添加服务器' }).click())
    await act(async () => page.getByLabelText('传输方式').selectOptions('sse'))
    await expect.element(page.getByLabelText('SSE 服务器 URL')).toBeVisible()

    await act(async () => {
      await page.getByLabelText('服务器 ID').fill('remote-sse')
      await page.getByLabelText('SSE 服务器 URL').fill('https://example.invalid/sse')
    })

    await act(async () => page.getByRole('button', { name: '保存', exact: true }).click())

    await vi.waitFor(() => {
      expect(saveServer).toHaveBeenCalledWith({ id: 'remote-sse', url: 'https://example.invalid/sse' })
    })
  })

  it('loads the full configuration when editing an existing server', async () => {
    await act(async () => root?.render(<MCPSettings />))

    await act(async () => page.getByRole('button', { name: '修改' }).click())

    await vi.waitFor(() => {
      expect(useMCPStore.getState().getServerConfig).toHaveBeenCalledWith('filesystem')
    })
    await expect.element(page.getByRole('button', { name: '保存', exact: true })).toBeVisible()
  })

  it('deletes a server after confirmation', async () => {
    await act(async () => root?.render(<MCPSettings />))

    await act(async () => page.getByTitle('删除服务器').click())

    await vi.waitFor(() => {
      expect(deleteServer).toHaveBeenCalledWith('filesystem')
    })
    expect(page.getByText('filesystem', { exact: true }).query()).toBeNull()
  })
})
