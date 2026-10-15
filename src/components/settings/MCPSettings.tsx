import { useEffect, useState } from 'react'
import {
  Plug,
  RefreshCw,
  Plus,
  Pencil,
  Trash2,
  Link2,
  Terminal,
  Power,
  ChevronDown,
  ChevronRight,
  Layers,
} from 'lucide-react'
import { useMCPStore } from '../../stores/mcp-store'
import { useLocaleStore } from '../../stores/locale-store'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'
import { NativeSelect } from '../ui/NativeSelect'
import { Textarea } from '../ui/Textarea'
import { confirm } from '../ui/Confirm'
import { toast } from '../ui/Toast'
import type { MCPConnectionStatus, MCPServerConfigView, MCPServerSaveRequest } from '../../shared/ipc-channels'
import { MCP_TEMPLATES, type MCPTemplate } from '../../shared/mcp-templates'

/** 状态点颜色（与 Agent 面板的 MCP 子视图同一套语义色）。 */
function statusColor(status: MCPConnectionStatus | undefined): string {
  switch (status) {
    case 'connected': return 'var(--color-success)'
    case 'connecting': return 'var(--color-warning)'
    case 'error': return 'var(--color-error)'
    default: return 'var(--color-text-muted)'
  }
}

function statusText(text: (zh: string, en: string) => string, status: MCPConnectionStatus | undefined): string {
  switch (status) {
    case 'connected': return text('已连接', 'Connected')
    case 'connecting': return text('连接中', 'Connecting')
    case 'error': return text('连接失败', 'Failed')
    default: return text('未连接', 'Disconnected')
  }
}

interface EditorDraft {
  id: string
  transport: 'stdio' | 'sse'
  command: string
  args: string
  env: string
  url: string
  disabled: boolean
}

const EMPTY_DRAFT: EditorDraft = {
  id: '',
  transport: 'stdio',
  command: '',
  args: '',
  env: '',
  url: '',
  disabled: false,
}

/** 解析「每行一个」的文本输入，去掉空行与首尾空白。 */
function linesOf(value: string): string[] {
  return value.split('\n').map(line => line.trim()).filter(Boolean)
}

/**
 * MCP 服务器管理页：添加、修改、删除项目助手可用的 MCP 服务器。
 * 配置以 ~/.vela/mcp_config.json（Claude Desktop 兼容格式）为唯一事实源，
 * 全部变更走主进程原子写盘。
 */
export default function MCPSettings() {
  const text = useLocaleStore(s => s.text)
  const {
    configs,
    servers,
    configPath,
    init,
    reloadConfig,
    refreshStatus,
    refreshTools,
    connectServer,
    disconnectServer,
    getServerConfig,
    saveServer,
    deleteServer,
    toggleServerDisabled,
    toolsForServer,
  } = useMCPStore()

  const [editor, setEditor] = useState<EditorDraft | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [expandedServerId, setExpandedServerId] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      await reloadConfig()
      await refreshStatus()
      await refreshTools()
    })()
  }, [reloadConfig, refreshStatus, refreshTools])

  const startCreate = () => {
    setEditingId(null)
    setEditor({ ...EMPTY_DRAFT })
  }

  const startEdit = async (id: string) => {
    setEditingId(id)
    setEditor(null)
    const result = await getServerConfig(id)
    if (!result.success || !result.config) {
      toast.error(result.error ?? text('无法读取该服务器的配置', 'Could not read the server configuration'))
      return
    }
    setEditor(configToDraft(result.config))
  }

  const applyTemplate = (tpl: MCPTemplate) => {
    setEditingId(null)
    setEditor(configToDraft({
      id: tpl.id,
      transport: tpl.transport,
      command: tpl.command,
      args: tpl.args,
      env: tpl.env,
      url: tpl.url,
      disabled: false,
    }))
  }

  const handleSave = async () => {
    if (!editor) return
    const id = editor.id.trim()
    if (!id) {
      toast.error(text('请填写服务器 ID', 'The server ID is required'))
      return
    }
    const isSse = editor.transport === 'sse'
    const command = editor.command.trim()
    const url = editor.url.trim()
    if (isSse && !url) {
      toast.error(text('请填写 SSE 服务器 URL', 'The SSE server URL is required'))
      return
    }
    if (!isSse && !command) {
      toast.error(text('请填写启动命令', 'The launch command is required'))
      return
    }
    setSaving(true)
    try {
      const payload: MCPServerSaveRequest = { id }
      if (isSse) {
        payload.url = url
      } else {
        payload.command = command
        payload.args = linesOf(editor.args)
        payload.env = envFromLines(editor.env)
      }
      if (editor.disabled) payload.disabled = true
      const result = await saveServer(payload)
      if (result.success) {
        toast.success(text('已保存并尝试连接', 'Saved and attempting to connect'))
        setEditor(null)
        setEditingId(null)
      } else {
        toast.error(result.error ?? text('保存失败', 'Save failed'))
      }
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    const ok = await confirm(
      text(`确定删除 MCP 服务器「${id}」？其连接会被断开，助手将不再拥有它的工具。`, `Delete the MCP server “${id}”? Its connection closes and the assistant loses its tools.`),
      {
        title: text('删除 MCP 服务器', 'Delete MCP server'),
        confirmText: text('删除', 'Delete'),
        danger: true,
      },
    )
    if (!ok) return
    const result = await deleteServer(id)
    if (result.success) {
      toast.success(text('已删除', 'Deleted'))
    } else {
      toast.error(result.error ?? text('删除失败', 'Delete failed'))
    }
  }

  const handleConnect = async (id: string) => {
    setBusyId(id)
    try {
      await connectServer(id)
    } catch {
      // 连接失败由状态点呈现，store 已记录错误。
    } finally {
      setBusyId(null)
      await refreshStatus()
    }
  }

  const handleDisconnect = async (id: string) => {
    setBusyId(id)
    try {
      await disconnectServer(id)
    } finally {
      setBusyId(null)
    }
  }

  const handleReload = async () => {
    await init()
    toast.success(text('已重新加载 MCP 配置', 'MCP configuration reloaded'))
  }

  const handleToggleDisabled = async (id: string, currentDisabled: boolean | undefined) => {
    setBusyId(id)
    try {
      await toggleServerDisabled(id, !currentDisabled)
      toast.success(currentDisabled ? text('已启用服务器', 'Server enabled') : text('已休眠服务器', 'Server disabled'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
            {text(
              'MCP（Model Context Protocol）服务器为项目助手提供外部工具。此处可以添加、修改、删除服务器；连接成功后，助手会以 mcp__<服务器>__<工具名> 的形式获得对应工具。',
              'MCP (Model Context Protocol) servers give the project assistant external tools. Add, edit, or delete servers here; once connected, the assistant gains their tools as mcp__<server>__<tool>.',
            )}
          </p>
          <p className="text-[0.68rem] mt-1 truncate" style={{ color: 'var(--color-text-muted)' }}>
            {text('配置文件：', 'Config file: ')}
            <code className="font-mono">{configPath ?? text('加载中…', 'loading…')}</code>
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button variant="outline" size="sm" onClick={() => void handleReload()} title={text('重新加载配置并重连', 'Reload configuration and reconnect')}>
            <RefreshCw size={12} />
            {text('重新加载', 'Reload')}
          </Button>
          <Button size="sm" onClick={startCreate} disabled={editor !== null}>
            <Plus size={12} />
            {text('添加服务器', 'Add server')}
          </Button>
        </div>
      </div>

      <div
        className="rounded-xl p-3"
        style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-bg-secondary)' }}
      >
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            <Layers size={13} style={{ color: 'var(--color-accent)' }} />
            <span className="text-xs font-semibold" style={{ color: 'var(--color-text)' }}>
              {text('推荐创作插件模版', 'Recommended Creative Plugins')}
            </span>
          </div>
          <span className="text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
            {text('点击一键预填标准配置', 'Click to pre-fill configuration')}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {MCP_TEMPLATES.map(tpl => {
            const isAdded = configs.some(c => c.id === tpl.id)
            return (
              <div
                key={tpl.id}
                className="flex flex-col justify-between p-2.5 rounded-lg"
                style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-panel)' }}
              >
                <div>
                  <div className="flex items-center justify-between gap-1 mb-1">
                    <span className="text-xs font-semibold truncate" style={{ color: 'var(--color-text)' }}>
                      {text(tpl.name, tpl.nameEn)}
                    </span>
                    <span
                      className="text-[0.62rem] px-1.5 py-0.2 rounded font-mono shrink-0"
                      style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text-secondary)' }}
                    >
                      {tpl.transport === 'stdio' ? 'stdio' : 'HTTP/SSE'}
                    </span>
                  </div>
                  <p className="text-[0.68rem] leading-relaxed line-clamp-2" style={{ color: 'var(--color-text-muted)' }}>
                    {text(tpl.description, tpl.descriptionEn)}
                  </p>
                </div>
                <div className="mt-2 flex items-center justify-between pt-1">
                  <span className="text-[0.62rem] font-mono opacity-60" style={{ color: 'var(--color-text-muted)' }}>
                    ID: {tpl.id}
                  </span>
                  <Button
                    variant={isAdded ? 'ghost' : 'outline'}
                    size="sm"
                    className="h-6 text-[0.68rem] px-2"
                    onClick={() => applyTemplate(tpl)}
                    disabled={editor !== null}
                  >
                    {isAdded ? text('已配置(覆盖)', 'Configured') : text('快速添加', 'Quick add')}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {editor !== null && (
        <div
          className="rounded-xl p-4 space-y-3"
          style={{ border: '1px solid var(--color-accent)', backgroundColor: 'var(--color-panel)' }}
        >
          <div className="flex items-center gap-2">
            <Plug size={14} style={{ color: 'var(--color-accent)' }} />
            <span className="text-xs font-semibold" style={{ color: 'var(--color-text)' }}>
              {editingId ? text(`修改服务器「${editingId}」`, `Edit server “${editingId}”`) : text('添加 MCP 服务器', 'Add an MCP server')}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs" htmlFor="mcp-id">{text('服务器 ID', 'Server ID')}</Label>
              <Input
                id="mcp-id"
                value={editor.id}
                disabled={editingId !== null}
                onChange={event => setEditor({ ...editor, id: event.target.value })}
                placeholder={text('例如 my-tools', 'e.g. my-tools')}
                className="font-mono"
              />
              <p className="text-[0.68rem] mt-1" style={{ color: 'var(--color-text-muted)' }}>
                {text('唯一标识，只能包含字母、数字、点、下划线与短横线；创建后不可修改。', 'Unique key with letters, digits, dots, underscores, or dashes; fixed after creation.')}
              </p>
            </div>
            <div>
              <Label className="text-xs" htmlFor="mcp-transport">{text('传输方式', 'Transport')}</Label>
              <NativeSelect
                id="mcp-transport"
                value={editor.transport}
                onChange={event => setEditor({ ...editor, transport: event.target.value === 'sse' ? 'sse' : 'stdio' })}
              >
                <option value="stdio">{text('本地命令 (stdio)', 'Local command (stdio)')}</option>
                <option value="sse">{text('远程服务 (SSE / Streamable HTTP)', 'Remote service (SSE / Streamable HTTP)')}</option>
              </NativeSelect>
            </div>
          </div>

          {editor.transport === 'stdio' ? (
            <>
              <div>
                <Label className="text-xs" htmlFor="mcp-command">{text('启动命令', 'Launch command')}</Label>
                <Input
                  id="mcp-command"
                  value={editor.command}
                  onChange={event => setEditor({ ...editor, command: event.target.value })}
                  placeholder={text('例如 npx', 'e.g. npx')}
                  className="font-mono"
                />
              </div>
              <div>
                <Label className="text-xs" htmlFor="mcp-args">{text('命令参数（每行一个）', 'Arguments (one per line)')}</Label>
                <Textarea
                  id="mcp-args"
                  value={editor.args}
                  onChange={event => setEditor({ ...editor, args: event.target.value })}
                  placeholder={text('例如\n-y\n@modelcontextprotocol/server-filesystem\nC:\\novels', 'e.g.\n-y\n@modelcontextprotocol/server-filesystem\nC:\\novels')}
                  className="font-mono"
                  style={{ minHeight: '64px' }}
                  spellCheck={false}
                />
              </div>
              <div>
                <Label className="text-xs" htmlFor="mcp-env">{text('环境变量（每行 KEY=VALUE）', 'Environment variables (one KEY=VALUE per line)')}</Label>
                <Textarea
                  id="mcp-env"
                  value={editor.env}
                  onChange={event => setEditor({ ...editor, env: event.target.value })}
                  placeholder={text('例如\nAPI_KEY=sk-...', 'e.g.\nAPI_KEY=sk-...')}
                  className="font-mono"
                  style={{ minHeight: '48px' }}
                  spellCheck={false}
                />
              </div>
            </>
          ) : (
            <div>
              <Label className="text-xs" htmlFor="mcp-url">{text('SSE 服务器 URL', 'SSE server URL')}</Label>
              <Input
                id="mcp-url"
                value={editor.url}
                onChange={event => setEditor({ ...editor, url: event.target.value })}
                placeholder="https://example.com/sse"
                className="font-mono"
              />
              <p className="text-[0.68rem] mt-1" style={{ color: 'var(--color-text-muted)' }}>
                {text('支持标准 SSE 与最新 Streamable HTTP 远程服务。', 'Supports standard SSE and Streamable HTTP remote services.')}
              </p>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
              {saving ? text('保存中…', 'Saving…') : text('保存', 'Save')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => { setEditor(null); setEditingId(null) }}>
              {text('取消', 'Cancel')}
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {configs.length === 0 && editor === null && (
          <div
            className="flex flex-col items-center justify-center gap-2 rounded-xl py-10"
            style={{ border: '1px dashed var(--color-border)' }}
          >
            <Terminal size={22} style={{ color: 'var(--color-text-muted)', opacity: 0.6 }} />
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {text('还没有配置任何 MCP 服务器', 'No MCP servers configured yet')}
            </p>
          </div>
        )}

        {configs.map(config => {
          const runtime = servers.find(server => server.id === config.id)
          const status = runtime?.status
          const isDisabled = config.disabled
          const serverTools = toolsForServer(config.id)
          const isExpanded = expandedServerId === config.id

          return (
            <div
              key={config.id}
              className="rounded-xl overflow-hidden transition-all"
              style={{
                border: '1px solid var(--color-border)',
                backgroundColor: 'var(--color-panel)',
                opacity: isDisabled ? 0.78 : 1,
              }}
            >
              <div className="flex items-center gap-3 px-3 py-2.5">
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: isDisabled ? 'var(--color-text-muted)' : statusColor(status) }}
                  title={isDisabled ? text('已休眠', 'Disabled') : statusText(text, status)}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium truncate" style={{ color: 'var(--color-text)' }}>
                      {config.name}
                    </span>
                    <span
                      className="text-[0.65rem] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 font-mono"
                      style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text-secondary)' }}
                    >
                      {config.transport === 'stdio' ? 'stdio' : 'SSE'}
                    </span>
                    {isDisabled && (
                      <span
                        className="text-[0.62rem] px-1.5 py-0.5 rounded font-medium flex-shrink-0"
                        style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text-muted)' }}
                      >
                        {text('休眠中', 'Disabled')}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                    <p className="text-[0.68rem] truncate" style={{ color: 'var(--color-text-muted)' }}>
                      {statusText(text, status)}
                      {status === 'connected' && text(` · ${runtime?.toolCount ?? 0} 个工具`, ` · ${runtime?.toolCount ?? 0} tools`)}
                    </p>
                    {!isDisabled && status === 'connected' && (
                      <button
                        type="button"
                        onClick={() => setExpandedServerId(isExpanded ? null : config.id)}
                        className="inline-flex items-center gap-0.5 text-[0.68rem] px-1.5 py-0.5 rounded hover:bg-[var(--color-hover)] transition-colors cursor-pointer"
                        style={{ color: 'var(--color-accent)' }}
                      >
                        <span>{isExpanded ? text('收起详情', 'Hide tools') : text('查看工具清单', 'Inspect tools')}</span>
                        {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleToggleDisabled(config.id, isDisabled)}
                    disabled={busyId === config.id}
                    title={isDisabled ? text('启用该服务器并注入工具', 'Enable server and load tools') : text('休眠该服务器，不向助手注入工具以节约上下文', 'Disable server to save context')}
                  >
                    <Power size={12} className={isDisabled ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-success)]'} />
                    {isDisabled ? text('启用', 'Enable') : text('休眠', 'Disable')}
                  </Button>

                  {!isDisabled && status === 'connected' && (
                    <Button variant="outline" size="sm" onClick={() => void handleDisconnect(config.id)} disabled={busyId === config.id}>
                      {text('断开', 'Disconnect')}
                    </Button>
                  )}
                  {!isDisabled && status !== 'connected' && (
                    <Button variant="outline" size="sm" onClick={() => void handleConnect(config.id)} disabled={busyId === config.id}>
                      <Link2 size={12} />
                      {text('连接', 'Connect')}
                    </Button>
                  )}

                  <Button variant="outline" size="sm" onClick={() => void startEdit(config.id)} disabled={editor !== null}>
                    <Pencil size={12} />
                    {text('修改', 'Edit')}
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => void handleDelete(config.id)} disabled={editor !== null} title={text('删除服务器', 'Delete server')}>
                    <Trash2 size={12} />
                  </Button>
                </div>
              </div>

              {isExpanded && !isDisabled && (
                <div
                  className="px-3 py-2.5 space-y-2"
                  style={{
                    backgroundColor: 'var(--color-bg-secondary)',
                    borderTop: '1px solid var(--color-border)',
                  }}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[0.72rem] font-medium" style={{ color: 'var(--color-text)' }}>
                      {text('可用工具列表', 'Available Tools')}
                    </span>
                    <span className="text-[0.65rem] font-mono" style={{ color: 'var(--color-text-muted)' }}>
                      {text(`共 ${serverTools.length} 个工具`, `${serverTools.length} tools total`)}
                    </span>
                  </div>
                  {serverTools.length === 0 ? (
                    <p className="text-[0.68rem] italic" style={{ color: 'var(--color-text-muted)' }}>
                      {text('暂未获取到工具描述（请确认连接已就绪）', 'No tools discovered yet (verify connection is ready)')}
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      {serverTools.map(tool => (
                        <div
                          key={tool.name}
                          className="p-2 rounded-lg text-xs"
                          style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-panel)' }}
                        >
                          <div className="flex items-center gap-1.5 mb-1">
                            <span className="font-mono font-semibold text-[0.75rem]" style={{ color: 'var(--color-accent)' }}>
                              {tool.name}
                            </span>
                          </div>
                          {tool.description && (
                            <p className="text-[0.68rem] leading-relaxed line-clamp-3 whitespace-pre-wrap" style={{ color: 'var(--color-text-secondary)' }}>
                              {tool.description}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function configToDraft(config: MCPServerConfigView): EditorDraft {
  return {
    id: config.id,
    transport: config.transport,
    command: config.command ?? '',
    args: (config.args ?? []).join('\n'),
    env: Object.entries(config.env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n'),
    url: config.url ?? '',
    disabled: !!config.disabled,
  }
}

function envFromLines(value: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of linesOf(value)) {
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    if (!key) continue
    env[key] = line.slice(separator + 1).trim()
  }
  return env
}
