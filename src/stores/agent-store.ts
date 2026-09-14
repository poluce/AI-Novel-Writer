import { create } from 'zustand'
import type { ToolCallInfo } from '../shared/agent-ui-types'
import { skillRegistry, type LoadedSkill } from '../services/agent/skill-registry'
import {
  getAllMentionTargets,
  getAllSlashCommands,
  parseSlashCommand,
} from '../services/agent/intent-router'
import {
  artifactFromToolResult,
  type ArtifactContext,
  type ToolArtifact,
} from '../shared/agent-artifacts'
import { captureAgentEditorSnapshot } from '../services/agent/editor-snapshot'
import { createAgentExecutionContext } from '../services/agent/tools/project-context'
import { writingLanguageText } from '../shared/writing-language'
import { projectSessionContextFromProject } from '../shared/project-session-context'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import {
  toAgentPromptHistory,
  type AgentConversationArchive,
  type PersistedAgentConversation,
} from '../shared/agent-conversation-archive'
import {
  formatDraftPassageCitations,
  type DraftPassageCitation,
} from '../shared/draft-excerpt'
import { ipc } from '../services/ipc-client'
import { logFailure, logInfo } from '../shared/fail-log'
import type { PiToolCallInfo, RendererAction, RendererActionResult } from '../shared/agent-events'
import { useLocaleStore } from './locale-store'
import { useProjectStore } from './project-store'
import { useEditorStore } from './editor-store'
import type { Locale } from '../i18n/types'

export const AGENT_GENERATION_BUDGET = Object.freeze({
  maxAttempts: 8,
  maxRequestedOutputTokens: 65_536,
  maxRequestedOutputTokensPerAttempt: 8192,
  deadlineMs: 20 * 60_000,
})

// ===== 类型定义 =====

/** 对话模式：Planning（深度推理）/ Fast（快速执行） */
export type AgentMode = 'planning' | 'fast'

/** 单条消息 */
export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
  /** 是否正在流式生成中 */
  streaming?: boolean
  /** Tool 调用信息（Agent 回复时） */
  toolCalls?: ToolCallInfo[]
  /** 产物列表（Agent 创建/修改的文件、触发的工作流等） */
  artifacts?: ToolArtifact[]
}

/** 单个会话 */
export interface AgentConversation {
  id: string
  /** 会话标题（取自第一条用户消息前 20 个字符） */
  title: string
  messages: AgentMessage[]
  createdAt: number
  updatedAt: number
  /** 当前会话使用的模式 */
  mode: AgentMode
  /** 当前会话使用的模型 ID（null 表示使用默认） */
  modelId: string | null
}

// ===== Store 状态接口 =====

export interface AgentState {
  /** 所有会话列表（最新的排在前面） */
  conversations: AgentConversation[]
  /** 当前活跃会话 ID */
  activeConversationId: string | null
  /** 是否显示历史面板 */
  showHistory: boolean
  /** 全局默认模式 */
  defaultMode: AgentMode
  /** 当前流式请求 ID（用于取消） */
  activeRequestId: string | null
  /** Tool 系统是否已初始化 */
  toolsInitialized: boolean
  /** 当前会话存档绑定的项目会话；无项目时为 null */
  dataProjectSession: ProjectSessionContext | null
  /** 待随下一句用户消息发送的草稿选区引用 */
  composerCitations: DraftPassageCitation[]

  // ===== 计算属性（Getters） =====
  /** 获取当前活跃会话 */
  getActiveConversation: () => AgentConversation | null

  // ===== Actions =====
  /** 初始化 Tool 系统 */
  initializeTools: () => void
  /** 新建会话并激活 */
  createConversation: () => AgentConversation
  /** 激活指定会话 */
  selectConversation: (id: string) => void
  /** 删除指定会话 */
  deleteConversation: (id: string) => void
  /** 清空所有会话 */
  clearAll: () => void
  /** 切换历史面板 */
  toggleHistory: () => void
  /** 设置历史面板可见性 */
  setShowHistory: (show: boolean) => void
  /** 设置当前会话模式 */
  setMode: (mode: AgentMode) => void
  /** 设置当前会话使用的模型 */
  setModelId: (modelId: string | null) => void
  /** 发送消息（触发 Agent ReAct 循环） */
  sendMessage: (content: string) => Promise<void>
  /** 取消当前生成 */
  cancelGeneration: () => Promise<void>
  /** 响应 Tool 确认（用于 ConfirmCard） */
  resolveToolConfirmation: (toolCallId: string, confirmed: boolean, options?: unknown) => void
  /** 切书/开书前清空界面会话，避免短暂显示上一本的对话 */
  beginProjectLoad: () => void
  /** 用当前项目存档替换内存中的会话 */
  hydrateFromArchive: (projectSession: ProjectSessionContext, archive: AgentConversationArchive) => void
  addComposerCitation: (citation: DraftPassageCitation) => void
  removeComposerCitation: (id: string) => void
}

// ===== 工具函数 =====

/** 生成唯一 ID */
const genId = () => crypto.randomUUID()

function fromPersistedConversation(conversation: PersistedAgentConversation): AgentConversation {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    mode: conversation.mode,
    modelId: conversation.modelId,
    messages: conversation.messages.map(message => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      toolCalls: Array.isArray(message.toolCalls) ? message.toolCalls as ToolCallInfo[] : undefined,
      artifacts: Array.isArray(message.artifacts) ? message.artifacts as ToolArtifact[] : undefined,
    })),
  }
}

/** 从消息内容生成会话标题 */
const generateTitle = (content: string): string => {
  const cleaned = content.replace(/\s+/g, ' ').trim()
  return cleaned.length > 24 ? cleaned.slice(0, 24) + '…' : cleaned
}

/** 生成 /help 命令的帮助文本 */
const generateHelpText = (locale: Locale): string => {
  const text = (zhCN: string, enUS: string) => locale === 'en-US' ? enUS : zhCN
  const skillCount = skillRegistry.listAll().length
  const commands = getAllSlashCommands(locale)
  const lines: string[] = [
    text('## AI小说作家 AI 助手 — 帮助', '## AI Novel Writer Assistant — Help'),
    '',
    text('### 可用命令', '### Available commands'),
    ...commands
      .filter(command => command.source === 'builtin_command')
      .map(command => `- \`/${command.name}\` — ${command.description}`),
    '',
    text('### @ 提及', '### @ mentions'),
    text(
      '输入 `@` 可提示助手用工具读取项目上下文：故事架构、角色卡、蓝图、知识库等。提及不会预先塞进消息。',
      `Type \`@\` to hint that the assistant should use tools for project context: ${getAllMentionTargets(locale).map(target => target.displayName).join(', ')}. Mentions are not prefetched into the message.`,
    ),
    '',
    text('### 可用工具', '### Available tools'),
    text(
      `读写与工作流工具在主进程执行。当前已加载 **${skillCount}** 个 Skill。`,
      `Read, write, and workflow tools run in the main process. Currently loaded: **${skillCount}** skills.`,
    ),
    '',
    text('### Skill 命令', '### Skill commands'),
  ]
  for (const command of commands.filter(command => command.source === 'skill')) {
    lines.push(`- \`/${command.name}\` — ${command.description}`)
  }
  lines.push('', text('有任何创作问题，直接问我即可！', 'Ask me whenever you need help with your story.'))
  return lines.join('\n')
}

// ===== 主进程 Agent 会话状态 =====
/** 当前流式会话 ID（用于路由 agent:event） */
let activeConversationId: string | null = null
/** 当前流式助手消息 ID（用于更新助手消息） */
let activeAssistantMsgId: string | null = null
let activeRequestUiLocale: Locale | null = null

/** True when the active conversation has an in-flight assistant turn. */
export function selectIsGenerating(state: Pick<AgentState, 'conversations' | 'activeConversationId'>): boolean {
  const conversation = state.conversations.find(item => item.id === state.activeConversationId)
  return Boolean(conversation?.messages.some(message => message.streaming))
}

/** 把主进程 PiToolCallInfo 映射为渲染层 ToolCallInfo（UI 兼容）。 */
function toToolCallInfo(call: PiToolCallInfo): ToolCallInfo {
  return {
    id: call.id,
    toolName: call.toolName,
    arguments: call.arguments as Record<string, unknown>,
    status: call.status,
    error: call.error,
    details: call.result,
    // MCP 工具的命名由主进程决定（mcp__server__tool），这里是唯一可推断来源的地方。
    source: call.toolName.startsWith('mcp__') ? 'mcp' : 'builtin',
  }
}

/** 当前项目的产物上下文；没有打开项目时不生成卡片。 */
export function currentArtifactContext(): ArtifactContext | null {
  const project = useProjectStore.getState().currentProject
  if (!project) return null
  return {
    projectPath: project.path,
    projectSession: projectSessionContextFromProject(project),
  }
}

/**
 * 工具完成时更新调用卡片，并在必要时追加产物卡片。
 * 导出以便直接测试这条渲染映射（主进程 details → 用户可见产物）。
 */
export function applyToolCallResult(
  message: AgentMessage,
  call: PiToolCallInfo,
  context: ArtifactContext | null,
): AgentMessage {
  const artifact = context
    ? artifactFromToolResult(call.toolName, call.result, context)
    : null
  return {
    ...message,
    toolCalls: (message.toolCalls ?? []).map(tc =>
      tc.id === call.id ? toToolCallInfo(call) : tc
    ),
    artifacts: artifact ? [...(message.artifacts ?? []), artifact] : message.artifacts,
  }
}

// ===== Zustand Store =====

export const useAgentStore = create<AgentState>()((set, get) => ({
  conversations: [],
  activeConversationId: null,
  showHistory: false,
  defaultMode: 'planning',
  activeRequestId: null,
  toolsInitialized: false,
  dataProjectSession: null,
  composerCitations: [],

  getActiveConversation: () => {
    const { conversations, activeConversationId } = get()
    return conversations.find(c => c.id === activeConversationId) ?? null
  },

  initializeTools: () => {
    if (get().toolsInitialized) return
    // Generation tools live in the main-process Pi Agent. Renderer only loads Skills for /commands.
    skillRegistry.loadAll().catch(e => console.warn('[Agent] Skill 加载失败:', e))
    set({ toolsInitialized: true })
  },

  createConversation: () => {
    // 确保 Tool 已初始化
    get().initializeTools()

    const newConv: AgentConversation = {
      id: genId(),
      title: useLocaleStore.getState().locale === 'en-US' ? 'New conversation' : '新对话',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode: get().defaultMode,
      // Null means “use the default once when a run starts”; the runtime then
      // freezes the selected lease across the entire ReAct loop.
      modelId: null,
    }
    set(state => ({
      conversations: [newConv, ...state.conversations],
      activeConversationId: newConv.id,
      showHistory: false,
    }))
    return newConv
  },

  selectConversation: (id) => {
    set({ activeConversationId: id, showHistory: false })
  },

  deleteConversation: (id) => {
    set(state => {
      const filtered = state.conversations.filter(c => c.id !== id)
      // 如果删除的是当前会话，激活下一条或 null
      const nextId = state.activeConversationId === id
        ? (filtered[0]?.id ?? null)
        : state.activeConversationId
      return { conversations: filtered, activeConversationId: nextId }
    })
  },

  clearAll: () => {
    set({ conversations: [], activeConversationId: null })
  },

  beginProjectLoad: () => {
    set({
      conversations: [],
      activeConversationId: null,
      showHistory: false,
      activeRequestId: null,
      dataProjectSession: null,
      composerCitations: [],
    })
  },

  addComposerCitation: (citation) => {
    set(state => ({
      composerCitations: [
        ...state.composerCitations.filter(item => item.quote !== citation.quote),
        citation,
      ],
    }))
  },

  removeComposerCitation: (id) => {
    set(state => ({
      composerCitations: state.composerCitations.filter(item => item.id !== id),
    }))
  },

  hydrateFromArchive: (projectSession, archive) => {
    const conversations = archive.conversations.map(fromPersistedConversation)
    const activeConversationId = archive.activeConversationId
      && conversations.some(conversation => conversation.id === archive.activeConversationId)
      ? archive.activeConversationId
      : conversations[0]?.id ?? null
    set({
      conversations,
      activeConversationId,
      showHistory: false,
      activeRequestId: null,
      dataProjectSession: projectSession,
    })
  },

  toggleHistory: () => {
    set(state => ({ showHistory: !state.showHistory }))
  },

  setShowHistory: (show) => {
    set({ showHistory: show })
  },

  setMode: (mode) => {
    const conv = get().getActiveConversation()
    if (!conv) {
      set({ defaultMode: mode })
      return
    }
    set(state => ({
      defaultMode: mode,
      conversations: state.conversations.map(c =>
        c.id === conv.id ? { ...c, mode } : c
      ),
    }))
  },

  setModelId: (modelId) => {
    const conv = get().getActiveConversation()
    if (!conv) return
    set(state => ({
      conversations: state.conversations.map(c =>
        c.id === conv.id ? { ...c, modelId } : c
      ),
    }))
  },

  sendMessage: async (content) => {
    if (!content.trim() && get().composerCitations.length === 0) return
    if (selectIsGenerating(get())) {
      logInfo('Agent', 'ignored send while a turn is already in flight')
      return
    }
    const requestLocale = useLocaleStore.getState().locale
    const text = (zhCNText: string, enUSText: string) => requestLocale === 'en-US' ? enUSText : zhCNText
    let skillInvocation: { skill: LoadedSkill; input: string } | null = null

    // 确保 Tool 已初始化
    get().initializeTools()

    // ===== P0-4: / 命令拦截 =====
    const trimmedContent = content.trim()
    if (trimmedContent.startsWith('/')) {
      const { command, args } = parseSlashCommand(trimmedContent, requestLocale)
      if (command) {
        switch (command.name) {
          case 'clear': {
            const activeConv = get().getActiveConversation()
            if (activeConv) {
              set(state => ({
                conversations: state.conversations.map(c =>
                  c.id === activeConv.id ? { ...c, messages: [] } : c
                ),
              }))
            }
            return
          }
          case 'new':
            get().createConversation()
            return
          case 'help': {
            // 构造帮助信息作为系统消息
            const helpConv = get().getActiveConversation() ?? get().createConversation()
            const helpMsg: AgentMessage = {
              id: genId(), role: 'assistant', content: generateHelpText(requestLocale), createdAt: Date.now(),
            }
            set(state => ({
              conversations: state.conversations.map(c =>
                c.id === helpConv.id ? { ...c, messages: [...c.messages, helpMsg] } : c
              ),
            }))
            return
          }
          case 'status': {
            // /status → 直接将 read_project_state 的结果展示
            // 不拦截，作为普通消息让 Agent 处理（它会调用 read_project_state）
            break
          }
          default:
            // Skill 命令：把 Skill 内容注入到用户消息中
            if (command.source === 'skill' && command.skill) {
              skillInvocation = {
                skill: command.skill,
                input: args,
              }
            }
            break
        }
      }
    }

    // 确保有活跃会话（无则创建）
    let conv = get().getActiveConversation()
    if (!conv) {
      conv = get().createConversation()
    }
    const convId = conv.id
    const modelId = conv.modelId ?? undefined
    const executionContext = createAgentExecutionContext(modelId, requestLocale)
    const modelText = (zhCNText: string, enUSText: string) => writingLanguageText(
      executionContext.writingLanguage,
      zhCNText,
      enUSText,
    )
    const citations = get().composerCitations
    if (citations.length > 0) {
      const citationBlock = formatDraftPassageCitations(citations, executionContext.writingLanguage)
      content = citationBlock ? `${citationBlock}\n\n${content}` : content
      set({ composerCitations: [] })
    }

    if (skillInvocation) {
      const skill = skillInvocation.skill
      const displayName = executionContext.writingLanguage === 'en-US'
        ? (skill.writingSkill.metadata.displayName ?? skill.metadata.name)
        : (skill.metadata.displayName ?? skill.metadata.name)
      let skillContent = skill.localizedContent?.[executionContext.writingLanguage] ?? skill.content
      if (skillInvocation.input) {
        skillContent = skillContent
          .replace(/\$\{args\}/g, skillInvocation.input)
          .replace(/\$1/g, skillInvocation.input)
      }
      content = `${modelText('[用户使用了 Skill:', '[The user invoked Skill:')} ${displayName}]\n\n${modelText('用户输入:', 'User input:')} ${skillInvocation.input || modelText('(无额外参数)', '(no additional arguments)')}\n\n---\n\n${skillContent}`
    }

    // 构建用户消息
    const userMsg: AgentMessage = {
      id: genId(),
      role: 'user',
      content: content.trim(),
      createdAt: Date.now(),
    }

    // 构建占位助手消息（ReAct 循环中实时更新）
    const assistantMsg: AgentMessage = {
      id: genId(),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      streaming: true,
      toolCalls: [],
      artifacts: [],
    }

    // 更新会话标题（取第一条用户消息）
    const isFirstMsg = conv.messages.length === 0
    const newTitle = isFirstMsg ? generateTitle(content) : conv.title

    // 把用户消息 + 空助手消息写入会话
    set(state => ({
      conversations: state.conversations.map(c =>
        c.id === convId
          ? {
              ...c,
              title: newTitle,
              messages: [...c.messages, userMsg, assistantMsg],
              updatedAt: Date.now(),
            }
          : c
      ),
    }))
    activeRequestUiLocale = requestLocale

    // 辅助函数：更新助手消息
    const updateAssistantMsg = (updater: (msg: AgentMessage) => AgentMessage) => {
      set(state => ({
        conversations: state.conversations.map(c =>
          c.id === convId
            ? {
                ...c,
                messages: c.messages.map(m =>
                  m.id === assistantMsg.id ? updater(m) : m
                ),
              }
            : c
        ),
      }))
    }

    try {
      // 设置活跃会话 + 助手消息（用于路由 agent:event）
      activeConversationId = convId
      activeAssistantMsgId = assistantMsg.id
      activeRequestUiLocale = requestLocale
      set({ activeRequestId: assistantMsg.id })

      logInfo('Agent', 'sending prompt', { conversationId: convId, modelId, chars: content.trim().length })
      const result = await ipc.invoke(
        'agent:prompt',
        convId,
        content.trim(),
        modelId,
        captureAgentEditorSnapshot(),
        toAgentPromptHistory(conv.messages),
      )
      if (!result.success) {
        logFailure('Agent', 'renderer prompt returned failure', undefined, {
          conversationId: convId,
          modelId,
          error: result.error,
        })
        updateAssistantMsg(m => ({
          ...m,
          content: text('生成失败，请重试。', 'Generation failed. Please try again.'),
          streaming: false,
        }))
        set({ activeRequestId: null })
        return
      }
      updateAssistantMsg(m => ({
        ...m,
        streaming: false,
        content: m.content.trim()
          ? m.content
          : text(
            '生成结束但没有返回正文。请查看 ~/.vela/logs/vela.log',
            'Generation finished with no text. See ~/.vela/logs/vela.log',
          ),
      }))
      set({ activeRequestId: null })
    } catch (error) {
      logFailure('Agent', 'renderer prompt threw', error, { conversationId: convId, modelId })
      updateAssistantMsg(m => ({
        ...m,
        content: text('生成失败，请重试。', 'Generation failed. Please try again.'),
        streaming: false,
      }))
      set({ activeRequestId: null })
    }
  },

  cancelGeneration: async () => {
    const cancelledUiLocale = activeRequestUiLocale ?? useLocaleStore.getState().locale
    const stoppedText = cancelledUiLocale === 'en-US'
      ? '\n\n_(Generation stopped)_'
      : '\n\n_（已停止生成）_'
    // 通知主进程中止当前会话的 Agent
    if (activeConversationId) {
      await ipc.invoke('agent:abort', activeConversationId)
    }

    // 找到正在 streaming 的消息，关闭其状态
    set(state => ({
      activeRequestId: null,
      conversations: state.conversations.map(c => ({
        ...c,
        messages: c.messages.map(m =>
          m.streaming ? { ...m, streaming: false, content: m.content + stoppedText } : m
        ),
      })),
    }))
  },

  resolveToolConfirmation: (toolCallId, confirmed) => {
    if (activeConversationId) {
      void ipc.invoke('agent:confirm', activeConversationId, toolCallId, confirmed)
    }
  },
}))

// ===== 主进程 Agent 事件订阅 =====

function updateActiveAssistantMsg(updater: (msg: AgentMessage) => AgentMessage): void {
  const convId = activeConversationId
  const msgId = activeAssistantMsgId
  if (!convId || !msgId) return
  useAgentStore.setState(state => ({
    conversations: state.conversations.map(c =>
      c.id === convId
        ? { ...c, messages: c.messages.map(m => m.id === msgId ? updater(m) : m) }
        : c
    ),
  }))
}

/** 处理主进程工具发来的渲染层动作；导出以便直接测试分派结果。 */
export async function handleRendererAction(action: RendererAction): Promise<RendererActionResult | void> {
  switch (action.type) {
    case 'open_editor': {
      // 数据库驱动的页面直接打开内置编辑器；只有 file 目标才带文件内容开标签页。
      if (action.target === 'builtin') {
        const { openBuiltinEditor } = await import('../components/panels/sidebar/sidebar-file-openers')
        const uiText = useLocaleStore.getState().text
        const builtin = {
          config: null,
          blueprints: ['chapter-card-editor', uiText('章节蓝图', 'Chapter blueprints'), 'chapter-card'],
          characters: ['character-editor', uiText('角色管理', 'Characters'), 'character'],
          architecture: ['world-building-editor', uiText('故事架构', 'Story architecture'), 'world-building'],
          synopsis: ['synopsis-editor', uiText('情节大纲', 'Plot outline'), 'synopsis'],
        } as const
        const entry = builtin[action.editor]
        if (entry === null) {
          useEditorStore.getState().openFile({
            id: 'config',
            name: uiText('小说配置', 'Novel configuration'),
            type: 'config',
            projectKey: useProjectStore.getState().currentProject?.path ?? '',
          })
          return
        }
        openBuiltinEditor(entry[0], entry[1], entry[2])
        return
      }
      useEditorStore.getState().openFile({
        id: `agent-${Date.now()}`,
        name: action.fileName,
        type: 'outline',
        filePath: action.filePath,
        content: action.content,
        savedContent: action.content,
        projectKey: useProjectStore.getState().currentProject?.path ?? '',
      })
      return
    }
    case 'start_workflow': {
      const project = useProjectStore.getState().currentProject
      const session = projectSessionContextFromProject(project)
      const uiText = useLocaleStore.getState().text
      if (!session) {
        const error = uiText('未打开项目，工作流未启动。', 'No project is open, so the workflow was not started.')
        logFailure('Agent', 'start_workflow skipped: no open project', undefined, {
          workflow: action.workflow,
        })
        return { ok: false, error }
      }
      try {
        const { launchCreativeWorkflow } = await import('../services/workflows/creative-workflow-launcher')
        const chapterWorkflows = new Set(['generate_draft', 'review', 'refine', 'finalize'])
        const intent = chapterWorkflows.has(action.workflow)
          ? { workflow: action.workflow, chapterNumber: action.chapterNumber as number }
          : { workflow: action.workflow }
        const receipt = await launchCreativeWorkflow(
          intent as import('../services/workflows/creative-workflow-launcher').CreativeIntent,
          session,
        )
        const workflowLabel = `${action.workflow}${action.chapterNumber != null ? uiText(`（第 ${action.chapterNumber} 章）`, ` (Chapter ${action.chapterNumber})`) : ''}`
        return {
          ok: true,
          summary: uiText(
            `已启动「${action.workflow}${action.chapterNumber != null ? `（第 ${action.chapterNumber} 章）` : ''}」工作流（运行 ID：${receipt.runId}，状态：${receipt.status}）。`,
            `Started the ${action.workflow}${action.chapterNumber != null ? ` (Chapter ${action.chapterNumber})` : ''} workflow (run ID: ${receipt.runId}; status: ${receipt.status}).`,
          ),
          workflow: { runId: receipt.runId, status: receipt.status, name: workflowLabel },
        }
      } catch (error) {
        logFailure('Agent', 'start_workflow launch failed', error, {
          workflow: action.workflow,
          chapterNumber: action.chapterNumber,
        })
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }
    case 'replace_draft_excerpt': {
      const { applyDraftExcerptReplace } = await import('../services/agent/apply-draft-excerpt')
      try {
        return await applyDraftExcerptReplace({
          chapterNumber: action.chapterNumber,
          oldText: action.oldText,
          newText: action.newText,
          draftId: action.draftId,
        })
      } catch (error) {
        logFailure('Agent', 'replace_draft_excerpt failed', error, {
          chapterNumber: action.chapterNumber,
        })
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }
    case 'refresh_project_config':
    case 'refresh_blueprint': {
      const project = useProjectStore.getState().currentProject
      if (!project) return
      void useProjectStore.getState().refreshFileTree(project.path).catch((error) => {
        logFailure('Agent', `${action.type} refresh failed`, error)
      })
      return
    }
  }
}

if (typeof window !== 'undefined') {
  ipc.on('agent:event', ({ conversationId, event }) => {
    if (conversationId !== activeConversationId) return
    switch (event.type) {
      case 'text_delta':
        updateActiveAssistantMsg(m => ({ ...m, content: m.content + event.delta }))
        break
      case 'tool_call_start':
        updateActiveAssistantMsg(m => ({
          ...m,
          toolCalls: [...(m.toolCalls ?? []), toToolCallInfo(event.call)],
        }))
        break
      case 'tool_call_confirm':
        updateActiveAssistantMsg(m => ({
          ...m,
          toolCalls: (m.toolCalls ?? []).map(tc =>
            tc.id === event.call.id ? { ...tc, status: 'waiting_confirm' as const } : tc
          ),
        }))
        break
      case 'tool_call_complete':
        updateActiveAssistantMsg(m => applyToolCallResult(m, event.call, currentArtifactContext()))
        break
      case 'done':
        logInfo('Agent', 'renderer received done', {
          conversationId,
          chars: event.fullText.length,
        })
        updateActiveAssistantMsg(m => ({ ...m, content: event.fullText, streaming: false }))
        useAgentStore.setState(state => ({
          activeRequestId: null,
          conversations: state.conversations.map(c =>
            c.id === conversationId ? { ...c, updatedAt: Date.now() } : c
          ),
        }))
        break
      case 'error':
        logFailure('Agent', 'renderer received error event', undefined, {
          conversationId,
          message: event.message,
        })
        updateActiveAssistantMsg(m => ({ ...m, content: event.message, streaming: false }))
        useAgentStore.setState({ activeRequestId: null })
        break
    }
  })

  ipc.on('agent:renderer-action', ({ action, requestId }) => {
    void handleRendererAction(action).then((result) => {
      if (!requestId) return
      const payload: RendererActionResult = result ?? {
        ok: false,
        error: useLocaleStore.getState().text(
          '工作流未能注册到任务中心，已拒绝报告启动成功。',
          'The workflow was not registered in the task panel, so start was not reported as success.',
        ),
      }
      return ipc.invoke('agent:renderer-action-result', requestId, payload)
    }).catch((error) => {
      logFailure('Agent', 'renderer action reply failed', error, { requestId })
      if (!requestId) return
      return ipc.invoke('agent:renderer-action-result', requestId, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  })
}
