import { useRef, useState, useEffect, useCallback } from 'react'
import {
  Plus,
  ChevronDown,
  ArrowRight,
  Square,
  Image,
  AtSign,
  Workflow,
  X,
  ChevronRight,
  ChevronLeft,
  Check} from 'lucide-react'
import { selectIsGenerating, useAgentStore } from '../../../stores/agent-store'
import { useLLMStore } from '../../../stores/llm-store'
import {
  groupModelsByChannel,
  type AssistantThinkingLevel} from '../../../shared/agent-runtime'
import { useOutsideClick } from '../../../hooks/useOutsideClick'
import SlashCommandMenu from './SlashCommandMenu'
import MentionMenu from './MentionMenu'
import type { SlashCommand, MentionTarget } from '../../../services/agent/intent-router'
import { useLocaleStore } from '../../../stores/locale-store'
import { cn } from '../../../lib/utils'

/** 输入框最大高度（px），超出后框内滚动 */
const MAX_HEIGHT = 200

/**
 * Agent 输入框组件（参考 agent1.html 第 69-155 行）
 * 卡片式圆角容器，底部工具栏含模式/模型/发送
 */
export default function AgentInputBox() {
  const text = useLocaleStore(s => s.text)
  const [inputText, setInputText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { sendMessage, cancelGeneration, setModelId, setThinkingLevel, removeComposerCitation, setExecutionMode } = useAgentStore()
  const composerCitations = useAgentStore(s => s.composerCitations)
  const executionMode = useAgentStore(s => s.executionMode)
  const generating = useAgentStore(selectIsGenerating)
  const models = useLLMStore(s => s.models)
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  const currentModelId = useAgentStore(s => {
    const active = s.conversations.find(c => c.id === s.activeConversationId)
    return active?.modelId ?? defaultModelId
  })
  const currentThinkingLevel = useAgentStore(s => {
    const active = s.conversations.find(c => c.id === s.activeConversationId)
    return active?.thinkingLevel ?? null
  })

  // 过滤出非仅限 embedding 专用的模型
  const chatModels = models.filter(m => !(m.purposes.length === 1 && m.purposes[0] === 'embedding'))

  // 找到当前模型信息
  const currentModel = models.find(m => m.id === currentModelId)
  // 同一渠道（provider + 协议 + baseUrl）下的模型归成一组：菜单按「渠道 → 模型」两层展示。
  const modelGroups = groupModelsByChannel(chatModels)

  // 下拉菜单状态
  const [showContextMenu, setShowContextMenu] = useState(false)
  const [showModelSelectMenu, setShowModelSelectMenu] = useState(false)
  const [showModeMenu, setShowModeMenu] = useState(false)
  const [selectPane, setSelectPane] = useState<'root' | 'model' | 'effort'>('root')

  // / 命令和 @ 提及菜单状态
  const [showSlashMenu, setShowSlashMenu] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [showMentionMenu, setShowMentionMenu] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')

  // 检测输入是否触发 / 或 @ 菜单
  const handleInputChange = useCallback((value: string) => {
    setInputText(value)

    // 检测 / 命令
    if (value.startsWith('/')) {
      const q = value.slice(1).split(' ')[0] ?? ''
      setSlashQuery(q)
      setShowSlashMenu(true)
      setShowMentionMenu(false)
    } else {
      setShowSlashMenu(false)
    }

    // 检测 @ 提及（在光标位置前面找 @）
    const lastAt = value.lastIndexOf('@')
    if (lastAt >= 0) {
      const afterAt = value.slice(lastAt + 1)
      // 如果 @ 后面没有空格，视为正在输入提及
      if (!afterAt.includes(' ')) {
        setMentionQuery(afterAt)
        setShowMentionMenu(true)
        setShowSlashMenu(false)
      } else {
        setShowMentionMenu(false)
      }
    } else {
      setShowMentionMenu(false)
    }
  }, [])

  // 选择 / 命令
  const handleSlashSelect = useCallback((cmd: SlashCommand) => {
    setShowSlashMenu(false)
    if (cmd.source === 'skill') {
      // Skill 命令：替换为 /skill-name 后面可以加参数
      setInputText(`/${cmd.name} `)
    } else {
      // 内置命令：直接发送
      setInputText('')
      sendMessage(`/${cmd.name}`)
    }
    textareaRef.current?.focus()
  }, [sendMessage])

  // 选择 @ 提及
  const handleMentionSelect = useCallback((target: MentionTarget) => {
    setShowMentionMenu(false)
    // 替换最后一个 @ 及其后面的文字为 @displayName
    const lastAt = inputText.lastIndexOf('@')
    if (lastAt >= 0) {
      const before = inputText.slice(0, lastAt)
      setInputText(`${before}@${target.displayName} `)
    }
    textareaRef.current?.focus()
  }, [inputText])

  const contextRef = useRef<HTMLDivElement>(null)
  const modelSelectRef = useRef<HTMLDivElement>(null)
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const modeMenuRef = useRef<HTMLDivElement>(null)

  // 调整文本框高度的通用函数
  const adjustHeight = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    // 先重置为 0px，让 scrollHeight 正确反映内容高度，避免 flex 布局拉伸导致计算出很大的初始高度
    ta.style.height = '0px'
    const next = Math.min(Math.max(ta.scrollHeight, 36), MAX_HEIGHT)
    ta.style.height = next + 'px'
    // 超出最大高度时框内滚动，否则隐藏滚动条
    ta.style.overflowY = ta.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden'
  }, [])

  // 监听尺寸变化以重新计算高度，避免刚挂载时宽度未稳定导致的 placeholder 异常换行撑起高度
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) {
      adjustHeight()
      return
    }
    const ro = new ResizeObserver(() => {
      adjustHeight()
    })
    ro.observe(ta)
    
    // 初始化调用一次即可
    adjustHeight()

    return () => ro.disconnect()
  }, [adjustHeight])

  // 内容变化时重新调整高度
  useEffect(() => {
    adjustHeight()
  }, [inputText, adjustHeight])

  // 点击外部关闭下拉（用 useOutsideClick 统一管理 ref）
  useOutsideClick(contextRef, () => setShowContextMenu(false), showContextMenu)
  useOutsideClick(modeMenuRef, () => setShowModeMenu(false), showModeMenu)
  useEffect(() => {
    if (!showModelSelectMenu) return
    const listener = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        modelSelectRef.current?.contains(target) ||
        modelMenuRef.current?.contains(target)
      ) {
        return
      }
      setShowModelSelectMenu(false)
      setSelectPane('root')
    }
    document.addEventListener('mousedown', listener)
    return () => document.removeEventListener('mousedown', listener)
  }, [showModelSelectMenu])

  /** 发送或停止 */
  const handleSendOrStop = useCallback(async () => {
    if (generating) {
      await cancelGeneration()
      return
    }
    if (!inputText.trim() && composerCitations.length === 0) return
    const text = inputText
    setInputText('')
    await sendMessage(text)
  }, [composerCitations.length, generating, inputText, sendMessage, cancelGeneration])

  /** 键盘事件：Enter 发送，Shift+Enter 换行 */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // / 或 @ 菜单打开时，由菜单组件处理键盘事件
    if (showSlashMenu || showMentionMenu) {
      if (['ArrowUp', 'ArrowDown', 'Enter'].includes(e.key)) {
        return // 让菜单组件通过 window 事件处理
      }
      if (e.key === 'Escape') {
        setShowSlashMenu(false)
        setShowMentionMenu(false)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendOrStop()
    }
  }

  const canSend = !generating && (inputText.trim().length > 0 || composerCitations.length > 0)

  return (
    <div
      className="relative flex flex-col gap-0 p-1.5"
      style={{
        backgroundColor: 'var(--color-hover)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',  /* 4px 方正风格 */
      }}
    >
      {/* / 命令菜单 */}
      {showSlashMenu && (
        <SlashCommandMenu
          query={slashQuery}
          onSelect={handleSlashSelect}
          onClose={() => setShowSlashMenu(false)}
        />
      )}

      {/* @ 提及菜单 */}
      {showMentionMenu && (
        <MentionMenu
          query={mentionQuery}
          onSelect={handleMentionSelect}
          onClose={() => setShowMentionMenu(false)}
        />
      )}

      {/* 上下文菜单（+ 按钮弹出） */}
      {showContextMenu && (
        <div
          className="absolute bottom-[calc(100%+8px)] left-0 z-50 py-1 rounded-lg shadow-lg"
          style={{
            width: 180,
            backgroundColor: 'var(--color-sidebar)',
            border: '1px solid var(--color-border)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.25)'}}
        >
          <div className="text-[0.7rem] px-3 pb-1 pt-1" style={{ color: 'var(--color-text-muted)' }}>
            {text('添加上下文', 'Add context')}
          </div>
          <ContextMenuItem icon={<Image size={13} />} label={text('媒体文件', 'Media file')} onClick={() => setShowContextMenu(false)} disabled />
          <ContextMenuItem icon={<AtSign size={13} />} label={text('@提及', '@ mention')} onClick={() => {
            setShowContextMenu(false)
            // 插入 @ 字符并触发 MentionMenu
            setInputText(prev => prev + '@')
            handleInputChange(inputText + '@')
            textareaRef.current?.focus()
          }} />
          <ContextMenuItem icon={<Workflow size={13} />} label={text('工作流命令', 'Workflow command')} onClick={() => {
            setShowContextMenu(false)
            // 插入 / 字符并触发 SlashCommandMenu
            setInputText('/')
            handleInputChange('/')
            textareaRef.current?.focus()
          }} />
        </div>
      )}

      {/* 模型与思考选择菜单 */}
      {showModelSelectMenu && (
        <div
          ref={modelMenuRef}
          className="absolute bottom-[calc(100%+8px)] left-0 z-50 py-1 rounded-lg shadow-lg"
          style={{
            width: 240,
            maxWidth: 'calc(100% - 8px)',
            backgroundColor: 'var(--color-sidebar)',
            border: '1px solid var(--color-border)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
            maxHeight: 320,
            overflowY: 'auto'}}
        >
          {/* 根视图：模型 > 与 思考 > */}
          {selectPane === 'root' && (
            <div className="py-1">
              <button
                type="button"
                onClick={() => setSelectPane('model')}
                className="w-full flex items-center justify-between px-3 py-2 text-xs transition-colors hover:bg-[var(--color-hover)] text-left"
              >
                <span className="font-medium text-[var(--color-text)] shrink-0">{text('模型', 'Model')}</span>
                <div className="flex items-center gap-1 text-[var(--color-text-muted)] min-w-0 ml-2">
                  <span className="truncate text-[0.75rem]">
                    {currentModel?.modelName ?? currentModel?.name ?? text('未选择', 'None')}
                  </span>
                  <ChevronRight size={13} className="flex-shrink-0" />
                </div>
              </button>
              <button
                type="button"
                onClick={() => setSelectPane('effort')}
                className="w-full flex items-center justify-between px-3 py-2 text-xs transition-colors hover:bg-[var(--color-hover)] text-left"
              >
                <span className="font-medium text-[var(--color-text)] shrink-0">{text('思考', 'Thinking')}</span>
                <div className="flex items-center gap-1 text-[var(--color-text-muted)] min-w-0 ml-2">
                  <span className="text-[0.75rem] truncate">{thinkingLevelLabel(text, currentThinkingLevel)}</span>
                  <ChevronRight size={13} className="flex-shrink-0" />
                </div>
              </button>
            </div>
          )}

          {/* 模型选择子视图：按渠道分组 */}
          {selectPane === 'model' && (
            <div>
              <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--color-border)] mb-1">
                <button
                  type="button"
                  onClick={() => setSelectPane('root')}
                  className="flex items-center gap-0.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-1.5 py-0.5 rounded hover:bg-[var(--color-hover)]"
                >
                  <ChevronLeft size={13} />
                  <span>{text('返回', 'Back')}</span>
                </button>
                <span className="text-xs font-medium ml-1 text-[var(--color-text)]">{text('选择模型', 'Select model')}</span>
              </div>
              {chatModels.length === 0 ? (
                <div className="px-3 py-2 text-xs text-[var(--color-text-muted)]">
                  {text('请先在设置中配置模型', 'Configure a model in Settings first')}
                </div>
              ) : (
                modelGroups.map(group => (
                  <div key={group.key} className="mb-2">
                    <div
                      className="px-3 py-1 text-[0.68rem] font-semibold text-[var(--color-text-muted)] truncate"
                      data-model-channel={group.key}
                    >
                      {group.channelName || group.label}
                    </div>
                    {group.models.map(entry => {
                      const isSelected = entry.profile.id === currentModelId
                      return (
                        <button
                          key={entry.profile.id}
                          type="button"
                          onClick={() => {
                            setModelId(entry.profile.id)
                            setShowModelSelectMenu(false)
                            setSelectPane('root')
                          }}
                          className={cn(
                            'w-full flex items-center justify-between px-3 py-1.5 text-xs transition-colors text-left',
                            isSelected
                              ? 'bg-[var(--color-hover)] font-medium text-[var(--color-accent)]'
                              : 'hover:bg-[var(--color-hover)] text-[var(--color-text)]',
                          )}
                        >
                          <span className="truncate">{entry.modelName}</span>
                          {isSelected && <Check size={14} className="text-[var(--color-accent)] flex-shrink-0 ml-2" />}
                        </button>
                      )
                    })}
                  </div>
                ))
              )}
            </div>
          )}

          {/* 思考等级子视图 */}
          {selectPane === 'effort' && (
            <div>
              <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--color-border)] mb-1">
                <button
                  type="button"
                  onClick={() => setSelectPane('root')}
                  className="flex items-center gap-0.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-1.5 py-0.5 rounded hover:bg-[var(--color-hover)]"
                >
                  <ChevronLeft size={13} />
                  <span>{text('返回', 'Back')}</span>
                </button>
                <span className="text-xs font-medium ml-1 text-[var(--color-text)]">{text('思考等级', 'Thinking level')}</span>
              </div>
              <div className="py-0.5">
                {[
                  { value: null, label: text('关（默认）', 'Off (default)'), desc: text('不指定等级，使用模型默认行为', 'Use model default behavior') },
                  { value: 'low' as const, label: text('低', 'Low'), desc: text('最快，适合简单改写与问答', 'Fastest; simple rewrites and questions') },
                  { value: 'medium' as const, label: text('中', 'Medium'), desc: text('平衡，适合常规创作与改稿', 'Balanced; everyday drafting and revision') },
                  { value: 'high' as const, label: text('高', 'High'), desc: text('最慢，适合大纲与复杂推理', 'Slowest; outlines and complex reasoning') },
                ].map(item => {
                  const isSelected = currentThinkingLevel === item.value
                  return (
                    <button
                      key={item.value ?? 'default'}
                      type="button"
                      data-thinking-level={item.value ?? 'default'}
                      onClick={() => {
                        setThinkingLevel(item.value)
                        setShowModelSelectMenu(false)
                        setSelectPane('root')
                      }}
                      className={cn(
                        'w-full flex items-center justify-between px-3 py-2 text-left text-xs transition-colors rounded-md mx-1',
                        isSelected ? 'bg-[var(--color-hover)]' : 'hover:bg-[var(--color-hover)]',
                      )}
                      style={{ width: 'calc(100% - 8px)' }}
                    >
                      <div className="flex flex-col">
                        <span className={cn('font-medium', isSelected ? 'text-[var(--color-accent)]' : 'text-[var(--color-text)]')}>{item.label}</span>
                        <span className="text-[0.7rem] text-[var(--color-text-muted)]">{item.desc}</span>
                      </div>
                      {isSelected && <Check size={14} className="text-[var(--color-accent)] flex-shrink-0 ml-2" />}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {composerCitations.length > 0 && (
        <div className="flex flex-wrap gap-1 px-1.5 pt-1 pb-1">
          {composerCitations.map(citation => {
            const location = [
              citation.chapterNumber != null
                ? text(`第${citation.chapterNumber}章`, `Ch.${citation.chapterNumber}`)
                : text('草稿', 'Draft'),
              citation.fromLine > 0
                ? (citation.toLine > citation.fromLine
                  ? `L${citation.fromLine}–${citation.toLine}`
                  : `L${citation.fromLine}`)
                : '',
            ].filter(Boolean).join(' · ')
            const preview = citation.quote.replace(/\s+/g, ' ').trim()
            return (
              <span
                key={citation.id}
                className="inline-flex items-center gap-1 max-w-[220px] px-1.5 py-0.5 rounded text-[10px]"
                style={{
                  backgroundColor: 'var(--color-panel)',
                  border: '1px solid var(--color-accent)',
                  color: 'var(--color-text)'}}
                title={`${location}\n${citation.quote}`}
              >
                <span className="truncate">
                  {location}
                  {' · '}
                  {preview.length > 18 ? `${preview.slice(0, 18)}…` : preview}
                </span>
                <button
                  type="button"
                  className="p-0.5 rounded shrink-0"
                  aria-label={text('移除引用', 'Remove excerpt')}
                  onClick={() => removeComposerCitation(citation.id)}
                >
                  <X size={10} />
                </button>
              </span>
            )
          })}
        </div>
      )}

      {/* 输入区域 */}
      <div className="relative w-full">
          <textarea
            ref={textareaRef}
            value={inputText}
            onChange={e => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={text('输入消息，@ 提及，/ 使用工作流...', 'Type a message, @ mention, or / use a workflow...')}
            rows={1}
            className="w-full resize-none outline-none bg-transparent text-xs leading-relaxed px-2 py-2"
            style={{
              color: 'var(--color-text)',
              minHeight: 36,
              maxHeight: MAX_HEIGHT,
              overflowY: 'hidden',
              display: 'block'}}
          />
        {/* 占位文字颜色已通过 tailwind placeholder 设置 */}
      </div>

      {/* 底部工具栏 */}
      <div className="flex items-center justify-between gap-1 px-1 mt-0.5">

        {/* 左侧工具按钮组 */}
        <div className="flex items-center gap-1 min-w-0 flex-1 overflow-hidden">

          {/* + 添加上下文 */}
          <div ref={contextRef} className="shrink-0">
            <ToolbarIconBtn
              title={text('添加上下文', 'Add context')}
              onClick={() => {
                setShowModelSelectMenu(false)
                setShowModeMenu(false)
                setShowContextMenu(v => !v)
              }}
            >
              <Plus size={14} />
            </ToolbarIconBtn>
          </div>

          {/* 执行模式切换：单触发器 + 弹窗菜单 */}
          <div ref={modeMenuRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => {
                setShowContextMenu(false)
                setShowModelSelectMenu(false)
                setShowModeMenu(v => !v)
              }}
              className="flex items-center gap-1 py-1 px-1.5 rounded-md text-xs transition-colors select-none font-medium hover:bg-[var(--color-hover)] cursor-pointer"
              style={{
                backgroundColor: 'var(--color-bg-secondary)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-text)',
              }}
              title={
                executionMode === 'writing'
                  ? text('写作模式：创作读写全自动放行', 'Writing mode: autonomous execution')
                  : text('计划模式：写操作需人工批准', 'Plan mode: writes require approval')
              }
            >
              <span>{executionMode === 'writing' ? text('写作', 'Write') : text('计划', 'Plan')}</span>
              <ChevronDown size={11} strokeWidth={1.5} className="text-[var(--color-text-muted)] shrink-0" />
            </button>

            {showModeMenu && (
              <div
                className="absolute bottom-[calc(100%+8px)] left-0 z-50 py-1 rounded-lg shadow-lg"
                style={{
                  width: 170,
                  backgroundColor: 'var(--color-sidebar)',
                  border: '1px solid var(--color-border)',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
                }}
              >
                <div className="text-[0.7rem] px-3 pb-1 pt-1 font-medium" style={{ color: 'var(--color-text-muted)' }}>
                  {text('执行模式', 'Execution mode')}
                </div>
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 text-xs transition-colors hover:bg-[var(--color-hover)] text-left cursor-pointer"
                  onClick={() => {
                    setExecutionMode('plan')
                    setShowModeMenu(false)
                  }}
                >
                  <div>
                    <div className={`font-medium ${executionMode === 'plan' ? 'text-[var(--color-accent)]' : 'text-[var(--color-text)]'}`}>
                      {text('计划', 'Plan')}
                    </div>
                    <div className="text-[0.68rem] text-[var(--color-text-muted)]">
                      {text('写操作需人工批准', 'Writes require approval')}
                    </div>
                  </div>
                  {executionMode === 'plan' && (
                    <Check size={13} className="text-[var(--color-accent)] shrink-0 ml-2" />
                  )}
                </button>
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 text-xs transition-colors hover:bg-[var(--color-hover)] text-left cursor-pointer"
                  onClick={() => {
                    setExecutionMode('writing')
                    setShowModeMenu(false)
                  }}
                >
                  <div>
                    <div className={`font-medium ${executionMode === 'writing' ? 'text-[var(--color-accent)]' : 'text-[var(--color-text)]'}`}>
                      {text('写作', 'Write')}
                    </div>
                    <div className="text-[0.68rem] text-[var(--color-text-muted)]">
                      {text('创作读写全自动放行', 'Autonomous execution')}
                    </div>
                  </div>
                  {executionMode === 'writing' && (
                    <Check size={13} className="text-[var(--color-accent)] shrink-0 ml-2" />
                  )}
                </button>
              </div>
            )}
          </div>

          {/* DSH 风格模型与思考选择器：单个触发器 + 二级面板联动 */}
          <div ref={modelSelectRef} className="relative min-w-0 flex-1 overflow-hidden">
            <button
              onClick={() => {
                setShowContextMenu(false)
                setShowModeMenu(false)
                if (showModelSelectMenu) {
                  setShowModelSelectMenu(false)
                  setSelectPane('root')
                } else {
                  setShowModelSelectMenu(true)
                  setSelectPane('root')
                }
              }}
              className="flex items-center gap-1 py-1 px-1.5 rounded-md text-xs min-w-0 transition-colors w-full max-w-full overflow-hidden"
              style={{
                color: 'var(--color-text-secondary)',
                opacity: 0.85,
              }}
              onMouseEnter={e => {
                e.currentTarget.style.backgroundColor = 'var(--color-hover)'
                e.currentTarget.style.opacity = '1'
              }}
              onMouseLeave={e => {
                e.currentTarget.style.backgroundColor = 'transparent'
                e.currentTarget.style.opacity = '0.85'
              }}
              title={`${currentModel?.modelName ?? currentModel?.name ?? text('选择模型', 'Select model')} · ${thinkingLevelLabel(text, currentThinkingLevel)}`}
            >
              <span className="truncate select-none font-medium min-w-0 flex-1 text-left">
                {currentModel?.modelName
                  ?? currentModel?.name
                  ?? (chatModels.length === 0 ? text('未配置模型', 'No model configured') : text('选择模型', 'Select model'))}
              </span>
              <span
                className="text-[0.68rem] px-1 rounded shrink-0 select-none font-normal"
                style={{ backgroundColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}
              >
                {thinkingLevelLabel(text, currentThinkingLevel)}
              </span>
              <ChevronDown size={13} strokeWidth={1.5} className="shrink-0" />
            </button>
          </div>
        </div>

        {/* 右侧：发送/停止 */}
        <div className="flex items-center gap-1 shrink-0 ml-1">
          <button
            onClick={handleSendOrStop}
            disabled={!generating && !canSend}
            className="flex items-center justify-center w-6 h-6 transition-all duration-150"
            style={{
              borderRadius: 'var(--radius-md)',
              backgroundColor: generating
                ? 'var(--color-text-secondary)'
                : canSend
                ? 'var(--color-accent)'
                : 'rgba(128,128,128,0.3)',
              color: '#ffffff',
              cursor: !generating && !canSend ? 'not-allowed' : 'pointer',
              opacity: !generating && !canSend ? 0.5 : 1}}
            title={generating ? text('停止生成', 'Stop generation') : text('发送消息', 'Send message')}
          >
            {generating ? (
              <Square size={10} fill="currentColor" />
            ) : (
              <ArrowRight size={13} strokeWidth={2.5} />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

// ===== 子组件 =====

/** 工具栏图标按钮 */
function ToolbarIconBtn({
  children,
  title,
  onClick}: {
  children: React.ReactNode
  title: string
  onClick?: () => void
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="flex items-center justify-center p-1 rounded-full transition-colors"
      style={{ color: 'var(--color-text-secondary)', opacity: 0.75 }}
      onMouseEnter={e => {
        e.currentTarget.style.backgroundColor = 'var(--color-hover)'
        e.currentTarget.style.opacity = '1'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.backgroundColor = 'transparent'
        e.currentTarget.style.opacity = '0.75'
      }}
    >
      {children}
    </button>
  )
}

/** 上下文菜单项 */
function ContextMenuItem({
  icon,
  label,
  onClick,
  disabled}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  const text = useLocaleStore(s => s.text)
  return (
    <button
      onClick={!disabled ? onClick : undefined}
      disabled={disabled}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
      style={{
        color: disabled ? 'var(--color-text-muted)' : 'var(--color-text)',
        cursor: disabled ? 'not-allowed' : 'pointer'}}
      onMouseEnter={e => {
        if (!disabled) e.currentTarget.style.backgroundColor = 'var(--color-hover)'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.backgroundColor = 'transparent'
      }}
    >
      <span style={{ color: 'var(--color-text-secondary)' }}>{icon}</span>
      {label}
      {disabled && <span className="ml-auto text-[0.7rem] opacity-40">{text('即将', 'Soon')}</span>}
    </button>
  )
}

/** 思考等级在按钮上的短标签。 */
function thinkingLevelLabel(
  text: (zhCNText: string, enUSText: string) => string,
  level: AssistantThinkingLevel | null,
): string {
  switch (level) {
    case 'low':
      return text('低', 'Low')
    case 'medium':
      return text('中', 'Medium')
    case 'high':
      return text('高', 'High')
    default:
      return text('关', 'Off')
  }
}
