import { Plus, MoreHorizontal, X, Server, Sparkles, ChevronRight, History } from 'lucide-react'
import { useAgentStore } from '../../../stores/agent-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useMCPStore } from '../../../stores/mcp-store'
import { skillRegistry, type LoadedSkill } from '../../../services/agent/skill-registry'
import { skillDescription, skillDisplayName } from '../../../services/agent/skill-catalog'
import { useRef, useState } from 'react'
import { confirm } from '../../ui/Confirm'
import { IconBtn } from '../../ui/IconBtn'
import { MenuItem } from '../../ui/MenuItem'
import { useOutsideClick } from '../../../hooks/useOutsideClick'
import { useLocaleStore } from '../../../stores/locale-store'
import type { AssistantType } from '../../../shared/agent-conversation-archive'

/**
 * Agent 面板顶部工具栏
 */
export default function AgentHeader({ assistantType = 'general' }: { assistantType?: AssistantType }) {
  const text = useLocaleStore(s => s.text)
  const {
    createConversation,
    toggleHistory,
    showHistory,
    showArchitectHistory,
    showBlueprintHistory,
    getActiveConversation,
  } = useAgentStore()
  const toggleAIPanel = useLayoutStore(s => s.toggleAIPanel)
  const [showMore, setShowMore] = useState(false)
  const [subView, setSubView] = useState<'main' | 'mcp' | 'skills'>('main')
  const moreRef = useRef<HTMLDivElement>(null)

  useOutsideClick(moreRef, () => { setShowMore(false); setSubView('main') }, showMore)

  const { servers: mcpServers, tools: mcpTools } = useMCPStore()
  const connectedCount = mcpServers.filter(s => s.status === 'connected').length
  const skills = skillRegistry.listAll()

  const activeConv = getActiveConversation(assistantType)
  const isCurrentEmpty = !activeConv || activeConv.messages.filter(m => m.role !== 'system').length === 0
  const isHistoryActive = assistantType === 'blueprint'
    ? showBlueprintHistory
    : assistantType === 'architect'
      ? showArchitectHistory
      : showHistory

  return (
    <div
      className="no-select flex items-center justify-between gap-1.5 px-2 flex-shrink-0"
      style={{
        height: 'var(--height-panel-header)',
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      <div
        className="min-w-0 truncate"
        style={{ color: 'var(--color-text-secondary)', fontSize: '0.75rem', fontWeight: 500 }}
      >
        {assistantType === 'blueprint'
          ? text('AI 蓝图助手', 'AI Blueprint Assistant')
          : assistantType === 'architect'
            ? text('AI 架构助手', 'AI Architecture Assistant')
            : text('AI 写作助手', 'AI Writing Assistant')}
      </div>

      <div className="flex items-center gap-1.5 px-0.5 flex-shrink-0 ml-auto">
        <IconBtn
          title={isCurrentEmpty ? text('当前对话为空，请先发送消息', 'The current conversation is empty') : text('新建对话', 'New conversation')}
          disabled={isCurrentEmpty}
          onClick={() => createConversation(assistantType)}
          size={18}
        >
          <Plus size={13} strokeWidth={1.5} />
        </IconBtn>

        <IconBtn
          title={text('历史对话', 'Conversation history')}
          onClick={() => toggleHistory(assistantType)}
          active={isHistoryActive}
          size={18}
        >
          <History size={15} strokeWidth={1.5} />
        </IconBtn>

        <div className="relative" ref={moreRef}>
          <IconBtn
            title={text('更多选项', 'More options')}
            onClick={() => { setShowMore(v => !v); setSubView('main') }}
            active={showMore}
            size={18}
          >
            <MoreHorizontal size={15} strokeWidth={1.5} />
          </IconBtn>

          {showMore && (
            <div
              className="absolute right-[-24px] top-full mt-1 z-50 py-1 rounded-lg shadow-lg"
              style={{
                width: subView === 'main' ? 180 : 230,
                maxWidth: 'calc(100vw - 32px)',
                backgroundColor: 'var(--color-sidebar)',
                border: '1px solid var(--color-border)',
                boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
              }}
            >
              {subView === 'main' && (
                <>
                  <MenuItem
                    label={text('MCP 服务器', 'MCP servers')}
                    icon={<Server size={13} />}
                    shortcut={connectedCount > 0 ? text(`${connectedCount} 在线`, `${connectedCount} online`) : ''}
                    onClick={() => setSubView('mcp')}
                  />
                  <MenuItem
                    label={text('技能列表', 'Skills')}
                    icon={<Sparkles size={13} />}
                    shortcut={skills.length > 0 ? text(`${skills.length} 个`, `${skills.length}`) : ''}
                    onClick={() => setSubView('skills')}
                  />
                  <MenuDivider margin="4px 0" />
                  <MenuItem
                    label={text('清空所有对话', 'Clear all conversations')}
                    danger
                    onClick={async () => {
                      setShowMore(false)
                      const ok = await confirm(text('确定要清空所有对话记录？\n此操作不可撤销。', 'Clear all conversation history?\nThis cannot be undone.'), {
                        title: text('清空对话记录', 'Clear conversation history'),
                        confirmText: text('确认清空', 'Clear all'),
                        danger: true})
                      if (ok) useAgentStore.getState().clearAll(assistantType)
                    }}
                  />
                </>
              )}

              {subView === 'mcp' && (
                <MCPSubView
                  servers={mcpServers}
                  toolCount={mcpTools.length}
                  onBack={() => setSubView('main')}
                />
              )}

              {subView === 'skills' && (
                <SkillSubView
                  skills={skills}
                  onBack={() => setSubView('main')}
                />
              )}
            </div>
          )}
        </div>

        <IconBtn
          title={
            assistantType === 'blueprint'
              ? text('关闭蓝图助手', 'Close Blueprint panel')
              : assistantType === 'architect'
                ? text('关闭架构助手', 'Close Architecture panel')
                : text('关闭 Agent 面板', 'Close Agent panel')
          }
          onClick={toggleAIPanel}
          size={18}
        >
          <X size={15} strokeWidth={1.5} />
        </IconBtn>
      </div>
    </div>
  )
}

function MenuDivider({ margin = '2px 0' }: { margin?: string }) {
  return <div style={{ height: 1, backgroundColor: 'var(--color-border)', margin }} />
}

function SubViewBackButton({
  title,
  meta,
  onBack,
}: {
  title: string
  meta: string
  onBack: () => void
}) {
  return (
    <button
      onClick={onBack}
      className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors"
      style={{ color: 'var(--color-text-secondary)' }}
      onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--color-hover)')}
      onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
    >
      <ChevronRight size={12} style={{ transform: 'rotate(180deg)' }} />
      <span className="font-medium">{title}</span>
      <span className="ml-auto text-[0.68rem] opacity-50">{meta}</span>
    </button>
  )
}

function EmptyHint({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="px-3 py-3 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
      <div className="mb-1">{title}</div>
      <div className="text-[0.68rem] opacity-60">{hint}</div>
    </div>
  )
}

function mcpStatusColor(status: string): string {
  switch (status) {
    case 'connected':
      return 'var(--color-success)'
    case 'connecting':
      return 'var(--color-warning)'
    case 'error':
      return 'var(--color-error)'
    default:
      return 'var(--color-text-muted)'
  }
}

function sourceBadge(
  source: string,
  text: (zh: string, en: string) => string,
): { bg: string; color: string; label: string } {
  switch (source) {
    case 'builtin':
      return { bg: 'color-mix(in srgb, var(--color-info) 12%, transparent)', color: 'var(--color-info)', label: text('内置', 'Built-in') }
    case 'user':
      return { bg: 'color-mix(in srgb, var(--color-accent) 12%, transparent)', color: 'var(--color-accent)', label: text('用户', 'User') }
    case 'project':
      return { bg: 'color-mix(in srgb, var(--color-success) 12%, transparent)', color: 'var(--color-success-text)', label: text('项目', 'Project') }
    default:
      return { bg: 'var(--color-hover)', color: 'var(--color-text-muted)', label: source }
  }
}

function MCPSubView({
  servers,
  toolCount,
  onBack,
}: {
  servers: { id: string; name: string; status: string; toolCount: number; error?: string }[]
  toolCount: number
  onBack: () => void
}) {
  const text = useLocaleStore(s => s.text)
  const connectedCount = servers.filter(s => s.status === 'connected').length

  return (
    <>
      <SubViewBackButton
        title={text('MCP 服务器', 'MCP servers')}
        meta={text(`${connectedCount}/${servers.length} 在线`, `${connectedCount}/${servers.length} online`)}
        onBack={onBack}
      />
      <MenuDivider />

      {servers.length === 0 ? (
        <EmptyHint
          title={text('暂无 MCP 服务器', 'No MCP servers')}
          hint={text('在用户配置目录中配置 MCP 服务器', 'Configure MCP servers in your user configuration directory')}
        />
      ) : (
        <div className="py-1 max-h-[200px] overflow-y-auto">
          {servers.map(server => (
            <div
              key={server.id}
              className="flex items-center gap-2 px-3 py-1.5 text-xs"
            >
              <span
                className="flex-shrink-0 w-1.5 h-1.5 rounded-full"
                style={{ backgroundColor: mcpStatusColor(server.status) }}
              />
              <span
                className="flex-1 truncate font-medium"
                style={{ color: 'var(--color-text)' }}
              >
                {server.name}
              </span>
              {server.status === 'connected' && server.toolCount > 0 && (
                <span className="text-[0.65rem] opacity-50 flex-shrink-0">
                  {server.toolCount} tools
                </span>
              )}
              {server.status === 'error' && (
                <span
                  className="text-[0.65rem] text-[var(--color-error-text)] truncate max-w-[80px]"
                  title={text('服务器连接失败', 'Server connection failed')}
                >
                  {text('错误', 'Error')}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {toolCount > 0 && (
        <>
          <MenuDivider />
          <div className="px-3 py-1.5 text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
            {text(`共 ${toolCount} 个 MCP 工具已注册`, `${toolCount} MCP tools registered`)}
          </div>
        </>
      )}
    </>
  )
}

function SkillSubView({
  skills,
  onBack,
}: {
  skills: LoadedSkill[]
  onBack: () => void
}) {
  const locale = useLocaleStore(s => s.locale)
  const text = useLocaleStore(s => s.text)

  return (
    <>
      <SubViewBackButton
        title={text('技能列表', 'Skills')}
        meta={text(`${skills.length} 个技能`, `${skills.length} skills`)}
        onBack={onBack}
      />
      <MenuDivider />

      {skills.length === 0 ? (
        <EmptyHint
          title={text('暂无可用技能', 'No skills available')}
          hint={text('在用户技能目录放入 SKILL.md 文件', 'Add SKILL.md files to your user skills directory')}
        />
      ) : (
        <div className="py-1 max-h-[240px] overflow-y-auto">
          {skills.map(skill => {
            const badge = sourceBadge(skill.source, text)
            return (
              <div
                key={skill.metadata.name}
                className="flex items-start gap-2 px-3 py-1.5 text-xs"
              >
                <Sparkles size={12} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--color-accent)' }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium truncate" style={{ color: 'var(--color-text)' }}>
                      {skillDisplayName(skill, locale)}
                    </span>
                    <span
                      className="text-[0.6rem] px-1 py-0 rounded flex-shrink-0"
                      style={{ backgroundColor: badge.bg, color: badge.color }}
                    >
                      {badge.label}
                    </span>
                  </div>
                  <div
                    className="text-[0.68rem] truncate mt-0.5"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {skillDescription(skill, locale)}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <MenuDivider />
      <div className="px-3 py-1.5 text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
        {text('输入', 'Type')} <code className="px-0.5 rounded" style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-accent)' }}>/</code> {text('可快速调用技能', 'to quickly invoke a skill')}
      </div>
    </>
  )
}
