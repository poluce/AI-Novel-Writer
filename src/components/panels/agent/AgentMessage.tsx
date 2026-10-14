/**
 * 单条消息渲染组件（升级版）
 *
 * 支持三种渲染模式：
 * - 用户消息：右对齐气泡
 * - 助手消息：左侧 Markdown 风格渲染
 * - Tool 调用：ToolCallBlock / ConfirmCard / ArtifactCard
 */
import { useState, useEffect } from 'react'
import {
  Check,
  Copy,
  ChevronRight,
  ChevronDown,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertTriangle,
} from 'lucide-react'
import type { AgentMessage as AgentMessageType } from '../../../stores/agent-store'
import type { ToolCallInfo } from '../../../shared/agent-ui-types'
import { useLocaleStore } from '../../../stores/locale-store'
import MarkdownContent, { StreamingCursor } from '../../ui/MarkdownContent'
import ToolCallBlock from './ToolCallBlock'
import ConfirmCard from './ConfirmCard'
import ArtifactCard from './ArtifactCard'
import '../../../styles/agent-tools.css'

interface Props {
  message: AgentMessageType
}

function getToolSummary(toolCalls: ToolCallInfo[], text: (zh: string, en: string) => string) {
  const hasWaitingConfirm = toolCalls.some(tc => tc.status === 'waiting_confirm')
  const hasRunning = toolCalls.some(tc => tc.status === 'running' || tc.status === 'pending')
  const hasFailed = toolCalls.some(tc => tc.status === 'failed')

  let statusIcon = <CheckCircle2 size={12} className="text-[var(--color-success)] shrink-0" />
  let statusText = text(`已执行 ${toolCalls.length} 个操作`, `Executed ${toolCalls.length} tools`)

  if (hasWaitingConfirm) {
    statusIcon = <AlertTriangle size={12} className="text-[var(--color-warning)] shrink-0 animate-pulse" />
    statusText = text('需要确认操作', 'Action requires confirmation')
  } else if (hasRunning) {
    statusIcon = <Loader2 size={12} className="text-[var(--color-accent)] shrink-0 animate-spin" />
    const runningCall = toolCalls.find(tc => tc.status === 'running' || tc.status === 'pending')
    statusText = text(
      `正在执行: ${runningCall?.toolName || '工具'}...`,
      `Running: ${runningCall?.toolName || 'tool'}...`,
    )
  } else if (hasFailed) {
    statusIcon = <XCircle size={12} className="text-[var(--color-error)] shrink-0" />
    statusText = text('执行完成（包含失败项）', 'Completed with errors')
  }

  const uniqueToolNames = Array.from(new Set(toolCalls.map(tc => tc.toolName)))

  return {
    hasWaitingConfirm,
    hasRunning,
    statusIcon,
    statusText,
    uniqueToolNames,
  }
}

function ToolCallsCollapsibleSection({
  toolCalls,
  text,
}: {
  toolCalls: ToolCallInfo[]
  text: (zh: string, en: string) => string
}) {
  const hasWaitingConfirm = toolCalls.some(tc => tc.status === 'waiting_confirm')
  const [expanded, setExpanded] = useState(hasWaitingConfirm)

  useEffect(() => {
    if (hasWaitingConfirm) {
      setExpanded(true)
    }
  }, [hasWaitingConfirm])

  const summary = getToolSummary(toolCalls, text)

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[0.72rem] transition-colors cursor-pointer select-none hover:bg-[var(--color-hover)]"
        style={{
          backgroundColor: 'var(--color-bg-secondary)',
          border: '1px solid var(--color-border)',
          color: 'var(--color-text-secondary)',
        }}
      >
        {summary.statusIcon}
        <span className="font-medium text-[var(--color-text)]">
          {summary.statusText}
        </span>
        {summary.uniqueToolNames.length > 0 && (
          <span className="truncate opacity-75 text-[var(--color-text-muted)]">
            · {summary.uniqueToolNames.join(' · ')}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1 text-[0.68rem] opacity-60 shrink-0">
          <span>{expanded ? text('收起', 'Hide') : text('详情', 'Details')}</span>
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
      </button>

      {/* 展开的卡片内容 */}
      {expanded && (
        <div className="mt-1.5 space-y-1.5">
          {toolCalls.map(tc => (
            tc.status === 'waiting_confirm' ? (
              <ConfirmCard key={tc.id} toolCall={tc} />
            ) : (
              <ToolCallBlock key={tc.id} toolCall={tc} />
            )
          ))}
        </div>
      )}

      {/* 即使折叠，未确认的卡片也始终显示在外，防止用户漏掉审批 */}
      {!expanded && summary.hasWaitingConfirm && (
        <div className="mt-1.5 space-y-1.5">
          {toolCalls.filter(tc => tc.status === 'waiting_confirm').map(tc => (
            <ConfirmCard key={tc.id} toolCall={tc} />
          ))}
        </div>
      )}
    </div>
  )
}

export default function AgentMessage({ message }: Props) {
  const { role, content, streaming, toolCalls, artifacts } = message
  const text = useLocaleStore(state => state.text)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }
  const copyButton = (
    <>
      <button
        type="button"
        aria-label={text('复制消息', 'Copy message')}
        title={copyState === 'copied'
          ? text('已复制', 'Copied')
          : text('复制消息', 'Copy message')}
        disabled={!content || streaming}
        onClick={() => void copyMessage()}
        className="flex h-5 w-5 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-0 hover:bg-[var(--color-hover)]"
        style={{ color: 'var(--color-text-muted)' }}
      >
        {copyState === 'copied' ? <Check size={12} /> : <Copy size={12} />}
      </button>
      {copyState === 'failed' && <span role="alert" className="sr-only">{text('无法复制这条消息', 'Could not copy this message')}</span>}
    </>
  )

  if (role === 'user') {
    return (
      <div className="group relative flex justify-end mb-2">
        <div
          className="max-w-[88%] px-3 py-2 rounded-2xl text-xs leading-relaxed break-words whitespace-pre-wrap"
          style={{
            backgroundColor: 'rgba(var(--color-accent-rgb), 0.12)',
            border: '1px solid rgba(var(--color-accent-rgb), 0.2)',
            color: 'var(--color-text)',
          }}
        >
          {content}
          <div className="flex justify-end mt-0.5">
            {copyButton}
          </div>
        </div>
      </div>
    )
  }

  // 助手消息
  return (
    <div className="group relative flex justify-start mb-2">
      <div
        className="max-w-full text-xs leading-relaxed break-words w-full"
        style={{ color: 'var(--color-text)' }}
      >
        {/* 1. 顶部：Tool 调用过程折叠条（自然时序位于正文之前，默认收拢） */}
        {toolCalls && toolCalls.length > 0 && (
          <ToolCallsCollapsibleSection
            toolCalls={toolCalls}
            text={text}
          />
        )}

        {/* 2. 中间：文本回复内容与底部解耦的操作栏 */}
        {content ? (
          <div>
            <MarkdownContent content={content} streaming={streaming} />
            <div className="flex items-center justify-end mt-1 pt-0.5">
              {copyButton}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between min-h-[16px]">
            {streaming ? (
              <span className="inline-flex items-center h-4">
                <StreamingCursor />
              </span>
            ) : <span />}
            {copyButton}
          </div>
        )}

        {/* 3. 底部：最终产物卡片列表 */}
        {artifacts && artifacts.length > 0 && (
          <div className="mt-2">
            {artifacts.map((a, i) => (
              <ArtifactCard key={`artifact-${i}`} artifact={a} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
