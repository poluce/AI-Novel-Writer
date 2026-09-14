import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { ArrowDown, FileText, Info, Trash2, Workflow } from 'lucide-react'
import { selectIsGenerating, useAgentStore } from '../../../stores/agent-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useProjectStore } from '../../../stores/project-store'
import { APP_BRAND } from '../../../shared/brand'
import { resolveWritingLanguage, type WritingLanguage } from '../../../shared/writing-language'
import type { Locale } from '../../../i18n/types'
import { captureAgentEditorSnapshot } from '../../../services/agent/editor-snapshot'
import { buildL1AgentContext } from '../../../services/agent/l1-context'
import { buildAgentSkillCatalog } from '../../../services/agent/skill-catalog'
import AgentMessage from './AgentMessage'
import AgentInputBox from './AgentInputBox'
import { formatRelativeTime } from '../../../utils/time'
import { useLocaleStore } from '../../../stores/locale-store'
import { ipc } from '../../../services/ipc-client'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '../../ui/Dialog'

/**
 * 对话区域主组件
 * - 空状态：上方欢迎词与最近会话，输入框固定在底部
 * - 有会话：消息列表 + 底部固定输入框
 */
export default function AgentConversation() {
  const { getActiveConversation, showHistory } = useAgentStore()
  const activeConv = getActiveConversation()

  // 历史面板模式
  if (showHistory) {
    return <AgentHistoryPanel />
  }

  // 空状态（无活跃会话）
  if (!activeConv || activeConv.messages.length === 0) {
    return <EmptyState />
  }

  // 有消息的对话视图
  return <ActiveConversation />
}

// ===== 空状态视图 =====

function EmptyState() {
  const text = useLocaleStore(s => s.text)
  const { conversations, selectConversation } = useAgentStore()
  // 取最近 3 条历史会话（不包含当前空会话）
  const recentConvs = conversations
    .filter(c => c && c.messages.length > 0)
    .slice(0, 3)



  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mb-1 pl-1 text-base font-semibold" style={{ color: 'var(--color-text)' }}>
          {text(APP_BRAND.zhName, APP_BRAND.enName)}
        </div>
        <div className="mb-3 pl-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {text('你的 AI 创作助手 — 支持', 'Your AI creative assistant — use')} <code className="px-1 py-0.5 rounded text-[0.68rem]" style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-accent)' }}>/</code> {text('命令和', 'commands and')} <code className="px-1 py-0.5 rounded text-[0.68rem]" style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-accent)' }}>@</code> {text('引用', 'mentions')}
        </div>

        {recentConvs.length > 0 && (
          <div className="mt-4">
            <div className="flex flex-col gap-0">
              {recentConvs.map(conv => (
                <RecentConversationItem
                  key={conv.id}
                  title={conv.title}
                  updatedAt={conv.updatedAt}
                  onClick={() => selectConversation(conv.id)}
                  onDelete={() => useAgentStore.getState().deleteConversation(conv.id)}
                />
              ))}
            </div>
            {conversations.filter(c => c.messages.length > 0).length > 3 && (
              <button
                onClick={() => useAgentStore.getState().setShowHistory(true)}
                className="mt-4 text-left text-xs transition-all hover:underline"
                style={{ color: 'var(--color-text-muted)' }}
                onMouseEnter={e => (e.currentTarget.style.opacity = '0.8')}
                onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
              >
                {text('查看全部对话', 'View all conversations')}
              </button>
            )}
          </div>
        )}

        <div className="pt-8 text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
          {text('AI 生成内容仅供参考，重要信息请自行核实。', 'AI-generated content is for reference only. Verify important information.')}
        </div>
      </div>

      <div
        className="flex-shrink-0 px-3 pb-3 pt-2"
        style={{ borderTop: '1px solid var(--color-border)' }}
      >
        <AgentToolbar />
        <AgentInputBox />
      </div>
    </div>
  )
}

// ===== 活跃对话视图 =====

function ActiveConversation() {
  const text = useLocaleStore(s => s.text)
  const { getActiveConversation } = useAgentStore()
  const generating = useAgentStore(selectIsGenerating)
  const activeConv = getActiveConversation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)

  // 消息变化时自动滚动到底部
  useEffect(() => {
    if (isAtBottom && scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth',
      })
    }
  }, [activeConv?.messages, generating, isAtBottom])

  // 监听滚动位置判断是否在底部
  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    setIsAtBottom(distanceFromBottom < 60)
  }

  /** 跳转到底部 */
  const scrollToBottom = () => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }

  if (!activeConv) return null

  return (
    <div className="flex flex-col h-full relative">
      {/* 消息列表滚动区 */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-4"
      >
        <div className="flex flex-col">
          {activeConv.messages
            .filter(m => m.role !== 'system')
            .map(msg => (
              <AgentMessage key={msg.id} message={msg} />
            ))}
        </div>
        {/* 底部空间 */}
        <div className="h-4" />
      </div>

      {/* 跳到底部浮动按钮 */}
      {!isAtBottom && (
        <button
          onClick={scrollToBottom}
          className="absolute z-10 flex items-center justify-center w-7 h-7 rounded-full shadow-md transition-all"
          style={{
            right: 16,
            bottom: 100,
            backgroundColor: 'var(--color-sidebar)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text-secondary)',
          }}
          title={text('回到底部', 'Back to bottom')}
          onMouseEnter={e => {
            e.currentTarget.style.borderColor = 'var(--color-accent)'
            e.currentTarget.style.color = 'var(--color-accent)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.borderColor = 'var(--color-border)'
            e.currentTarget.style.color = 'var(--color-text-secondary)'
          }}
        >
          <ArrowDown size={13} strokeWidth={2.25} />
        </button>
      )}

      {/* 底部工具栏 + 输入区 */}
      <div
        className="flex-shrink-0 px-3 pb-3 pt-2"
        style={{ borderTop: '1px solid var(--color-border)' }}
      >
        <AgentToolbar />
        <AgentInputBox />
      </div>
    </div>
  )
}

// ===== Agent 底部工具栏（小说创作场景） =====

/**
 * 重构后的工具栏：贴合小说创作场景
 * 左侧：快速引用按钮（架构、角色、蓝图）
 * 右侧：打开 AI 输出面板按钮
 */
function toolbarChipStyle() {
  return {
    color: 'var(--color-text-muted)',
    border: '1px solid var(--color-border)',
  } as const
}

/** 助手提示词预览按项目写作语言渲染，与真实请求一致（无项目时退回界面语言）。 */
function agentWritingLanguage(locale: Locale): WritingLanguage {
  const project = useProjectStore.getState().currentProject
  return project
    ? resolveWritingLanguage(project.novelConfig.writingLanguage)
    : locale
}

function AgentToolbar() {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const openRightPanel = useLayoutStore(s => s.openRightPanel)
  const [inspect, setInspect] = useState<{
    kind: 'system' | 'turn'
    body: string
  } | null>(null)

  const chipHover = {
    onMouseEnter: (e: MouseEvent<HTMLButtonElement>) => {
      e.currentTarget.style.backgroundColor = 'var(--color-hover)'
      e.currentTarget.style.color = 'var(--color-text)'
    },
    onMouseLeave: (e: MouseEvent<HTMLButtonElement>) => {
      e.currentTarget.style.backgroundColor = 'transparent'
      e.currentTarget.style.color = 'var(--color-text-muted)'
    },
  }

  const openTurnContext = () => {
    const language = agentWritingLanguage(locale)
    const snapshot = captureAgentEditorSnapshot({ commitSurface: false })
    setInspect({
      kind: 'turn',
      body: buildL1AgentContext(snapshot, language) ?? '',
    })
  }

  const openSystemPrompt = async () => {
    try {
      const result = await ipc.invoke(
        'agent:system-prompt',
        buildAgentSkillCatalog(agentWritingLanguage(locale)),
      )
      setInspect({
        kind: 'system',
        body: result.success
          ? (result.prompt ?? '')
          : (result.error ?? text('无法读取系统提示词', 'Could not read the system prompt')),
      })
    } catch (error) {
      setInspect({
        kind: 'system',
        body: text(`无法读取系统提示词：${error}`, `Could not read the system prompt: ${error}`),
      })
    }
  }

  return (
    <div className="flex items-center justify-between gap-2 mb-1.5">
      <div className="flex items-center gap-1.5 min-w-0">
        <button
          type="button"
          onClick={() => void openSystemPrompt()}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all select-none"
          style={toolbarChipStyle()}
          title={text('查看助手系统提示词', 'View the assistant system prompt')}
          {...chipHover}
        >
          <FileText size={12} strokeWidth={1.75} />
          {text('系统提示词', 'System prompt')}
        </button>
        <button
          type="button"
          onClick={openTurnContext}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all select-none"
          style={toolbarChipStyle()}
          title={text('查看本轮发给助手的额外上下文', 'View extra context sent with this turn')}
          {...chipHover}
        >
          <Info size={12} strokeWidth={1.75} />
          {text('本轮上下文', 'Turn context')}
        </button>
      </div>

      <button
        type="button"
        onClick={() => openRightPanel('ai-output')}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all select-none"
        style={toolbarChipStyle()}
        title={text('切换到 AI 输出面板', 'Switch to AI output panel')}
        {...chipHover}
      >
        <Workflow size={12} strokeWidth={1.75} />
        {text('AI 工作流', 'AI workflow')}
      </button>

      <Dialog open={inspect !== null} onOpenChange={open => { if (!open) setInspect(null) }} modal={false}>
        <DialogContent
          overlay={false}
          className="max-w-[520px]"
          onInteractOutside={event => event.preventDefault()}
          onPointerDownOutside={event => event.preventDefault()}
          onFocusOutside={event => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>
              {inspect?.kind === 'system'
                ? text('系统提示词', 'System prompt')
                : text('本轮上下文', 'This turn’s context')}
            </DialogTitle>
            <DialogDescription>
              {inspect?.kind === 'system'
                ? text(
                    '助手的基础身份与当前项目摘要。不含本轮界面状态，也不含工具列表。',
                    'The assistant’s identity and current project summary. This is not the per-turn UI state or the tool list.',
                  )
                : text(
                    '发送下一条消息时附带的应用状态。不含系统提示词，也不含文件正文。',
                    'App state attached to the next message. This is not the system prompt and does not include file bodies.',
                  )}
            </DialogDescription>
          </DialogHeader>
          <pre
            className="mx-5 mb-5 mt-3 max-h-[50vh] overflow-y-auto whitespace-pre-wrap rounded-md px-3 py-2 text-xs leading-relaxed"
            style={{
              backgroundColor: 'var(--color-editor-bg)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-text)',
            }}
          >
            {inspect?.body
              || (inspect?.kind === 'system'
                ? text('（没有系统提示词）', '(No system prompt)')
                : text('（本轮没有额外上下文）', '(No extra context this turn)'))}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ===== 历史面板 =====

function AgentHistoryPanel() {
  const text = useLocaleStore(s => s.text)
  const { conversations, activeConversationId, selectConversation, deleteConversation, setShowHistory } = useAgentStore()

  // 按更新时间倒序排列
  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <div className="flex flex-col h-full">
      {/* 面板标题 */}
      <div
        className="flex items-center justify-between px-3 py-2 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--color-border)' }}
      >
        <span className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
          {text('全部对话', 'All conversations')}
        </span>
        <button
          onClick={() => setShowHistory(false)}
          className="text-xs px-2 py-0.5 rounded transition-colors"
          style={{ color: 'var(--color-text-muted)' }}
          onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--color-hover)')}
          onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
        >
          {text('关闭', 'Close')}
        </button>
      </div>

      {/* 会话列表 */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {sorted.length === 0 ? (
          <div className="flex items-center justify-center h-24 text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {text('暂无对话记录', 'No conversation history')}
          </div>
        ) : (
          sorted.map(conv => (
            <RecentConversationItem
              key={conv.id}
              title={conv.title}
              updatedAt={conv.updatedAt}
              isActive={conv.id === activeConversationId}
              onClick={() => selectConversation(conv.id)}
              onDelete={() => deleteConversation(conv.id)}
            />
          ))
        )}
      </div>
    </div>
  )
}

// ===== 最近会话列表项 =====

function RecentConversationItem({
  title,
  updatedAt,
  isActive,
  onClick,
  onDelete,
}: {
  title: string
  updatedAt: number
  isActive?: boolean
  onClick: () => void
  onDelete: () => void
}) {
  const locale = useLocaleStore(s => s.locale)
  const text = useLocaleStore(s => s.text)
  return (
    <button
      onClick={onClick}
      className="group w-full flex flex-row items-center justify-between overflow-hidden rounded py-1.5 text-left px-2 box-border transition-colors"
      style={{ backgroundColor: isActive ? 'var(--color-hover)' : 'transparent' }}
      onMouseEnter={e => { if (!isActive) e.currentTarget.style.backgroundColor = 'var(--color-hover)' }}
      onMouseLeave={e => { if (!isActive) e.currentTarget.style.backgroundColor = 'transparent' }}
    >
      {/* 标题 */}
      <div className="flex items-center gap-x-1 overflow-hidden flex-1 min-w-0">
        <div
          className="truncate text-xs"
          style={{ color: 'var(--color-text)', opacity: isActive ? 1 : 0.65 }}
        >
          {title}
        </div>
      </div>

      {/* 右侧：时间 or 删除（纯 CSS group-hover 控制） */}
      <div className="flex-shrink-0 ml-2">
        <button
          onClick={e => {
            e.stopPropagation()
            onDelete()
          }}
          className="hidden group-hover:flex items-center justify-center w-4 h-4 rounded opacity-50 hover:opacity-100 transition-opacity"
          style={{ color: 'var(--color-text-secondary)' }}
          title={text('删除对话', 'Delete conversation')}
        >
          <Trash2 size={12} />
        </button>
        <span
          className="group-hover:hidden text-[0.7rem] whitespace-nowrap"
          style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}
        >
          {formatRelativeTime(updatedAt, locale)}
        </span>
      </div>
    </button>
  )
}
