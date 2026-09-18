import { create } from 'zustand'
import type { ToolCallInfo } from '../shared/agent-ui-types'
import { skillRegistry, type LoadedSkill } from '../services/agent/skill-registry'
import { buildAgentSkillCatalog, skillDisplayName } from '../services/agent/skill-catalog'
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
import { createAgentExecutionContext } from '../services/agent/project-context'
import { writingLanguageText } from '../shared/writing-language'
import { projectSessionContextFromProject } from '../shared/project-session-context'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import type { AssistantThinkingLevel } from '../shared/agent-runtime'
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
import { describeProviderFailure } from '../shared/provider-error-message'
import { describeAgentTurnRefusal } from '../shared/agent-turn-refusal'
import type {
  PiAgentEvent,
  PiToolCallInfo,
  RendererActionResult,
} from '../shared/agent-events'
import { handleRendererAction } from '../services/agent/renderer-actions'
import { useLocaleStore } from './locale-store'
import { useProjectStore } from './project-store'
import type { Locale } from '../i18n/types'
import { DEFAULT_AGENT_SCOPE, type AgentScope } from '../shared/agent-scope'

export { handleRendererAction }

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
  /** 会话级思考等级；null 表示不指定（Pi 默认的 off）。 */
  thinkingLevel: AssistantThinkingLevel | null
  /** 属于哪个助手：项目助手（跟着书）/ 界面助手（跟着应用） */
  scope: AgentScope
}

// ===== Store 状态接口 =====

export interface AgentState {
  /** 所有会话列表（最新的排在前面，两个助手共用一份，用 scope 区分） */
  conversations: AgentConversation[]
  /** 当前展示的助手作用域 */
  activeScope: AgentScope
  /** 每个作用域各自记住的活跃会话（切回来时还原） */
  scopeActiveConversationIds: Record<AgentScope, string | null>
  /** 当前活跃会话 ID（属于 activeScope） */
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
  /** 清空当前助手的会话（不会动另一个助手） */
  clearAll: () => void
  /** 切换助手作用域（项目助手 / 界面助手） */
  setScope: (scope: AgentScope) => void
  /** 切换历史面板 */
  toggleHistory: () => void
  /** 设置历史面板可见性 */
  setShowHistory: (show: boolean) => void
  /** 设置当前会话模式 */
  setMode: (mode: AgentMode) => void
  /** 设置当前会话使用的模型档案（渠道）；同时清掉会话级模型覆盖。 */
  setModelId: (modelId: string | null) => void
  /** 设置当前会话的思考等级；null 表示不指定（Pi 默认）。 */
  setThinkingLevel: (thinkingLevel: AssistantThinkingLevel | null) => void
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
  /** 用某个助手的存档替换该作用域的会话（项目/界面共用） */
  replaceConversations: (scope: AgentScope, archive: AgentConversationArchive) => void
  addComposerCitation: (citation: DraftPassageCitation) => void
  removeComposerCitation: (id: string) => void
}

// ===== 工具函数 =====

/** 生成唯一 ID */
const genId = () => crypto.randomUUID()

function fromPersistedConversation(
  conversation: PersistedAgentConversation,
  scope: AgentScope,
): AgentConversation {
  return {
    id: conversation.id,
    title: conversation.title,
    scope,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    mode: conversation.mode,
    modelId: conversation.modelId,
    thinkingLevel: conversation.thinkingLevel ?? null,
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
/**
 * 在途回合表：按会话 ID 记录这一轮的助手消息与界面语言。
 *
 * 之前是「当前会话」两个单例，切到另一个助手就会把后台那一侧的流式事件
 * 丢掉；改成按会话索引之后，两边同时生成也不会串。
 */
interface InflightTurn {
  assistantMsgId: string
  uiLocale: Locale
}
const inflightTurns = new Map<string, InflightTurn>()

/** True when the active conversation has an in-flight assistant turn. */
export function selectIsGenerating(state: Pick<AgentState, 'conversations' | 'activeConversationId'>): boolean {
  const conversation = state.conversations.find(item => item.id === state.activeConversationId)
  return Boolean(conversation?.messages.some(message => message.streaming))
}

/** 把主进程 PiToolCallInfo 映射为渲染层 ToolCallInfo（UI 兼容）。 */
function toToolCallInfo(call: PiToolCallInfo): ToolCallInfo {
  const resultText = typeof call.result === 'string'
    ? call.result
    : call.result
      ? JSON.stringify(call.result, null, 2)
      : undefined
  return {
    id: call.id,
    toolName: call.toolName,
    arguments: call.arguments as Record<string, unknown>,
    status: call.status,
    error: call.error,
    details: call.result,
    result: resultText,
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
  activeScope: DEFAULT_AGENT_SCOPE,
  scopeActiveConversationIds: { project: null, global: null },
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

    const scope = get().activeScope
    const previous = get().getActiveConversation()
    const inheritFromPrevious = previous?.scope === scope ? previous : null
    const newConv: AgentConversation = {
      id: genId(),
      title: useLocaleStore.getState().locale === 'en-US' ? 'New conversation' : '新对话',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode: get().defaultMode,
      // 新会话抄当前这条同作用域对话的模型和思考档；没有上一条才留空，
      // 运行时再冻结默认模型 / Pi 默认思考。
      modelId: inheritFromPrevious?.modelId ?? null,
      thinkingLevel: inheritFromPrevious?.thinkingLevel ?? null,
      scope,
    }
    set(state => ({
      conversations: [newConv, ...state.conversations],
      activeConversationId: newConv.id,
      scopeActiveConversationIds: {
        ...state.scopeActiveConversationIds,
        [newConv.scope]: newConv.id,
      },
      showHistory: false,
    }))
    return newConv
  },

  selectConversation: (id) => {
    set(state => ({
      activeConversationId: id,
      scopeActiveConversationIds: { ...state.scopeActiveConversationIds, [state.activeScope]: id },
      showHistory: false,
    }))
  },

  setScope: (scope) => {
    const state = get()
    if (state.activeScope === scope) return
    const remembered = state.scopeActiveConversationIds[scope] ?? null
    const inScope = state.conversations.filter(conversation => conversation.scope === scope)
    const nextActive = remembered && inScope.some(conversation => conversation.id === remembered)
      ? remembered
      : inScope[0]?.id ?? null
    set({
      activeScope: scope,
      activeConversationId: nextActive,
      scopeActiveConversationIds: {
        ...state.scopeActiveConversationIds,
        [state.activeScope]: state.activeConversationId,
        [scope]: nextActive,
      },
      showHistory: false,
    })
  },

  deleteConversation: (id) => {
    // Pi 会话存档跟着一起删；存档在哪个作用域，就删哪一份。
    const scope = get().conversations.find(conversation => conversation.id === id)?.scope
      ?? get().activeScope
    void ipc.invoke('agent:discard-session', id, scope).catch((error) => {
      logFailure('Agent', 'discard conversation session failed', error, { conversationId: id, scope })
    })
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
    const state = get()
    // 只清当前助手：在项目里点「清空」不能把界面助手的全局会话一起删掉。
    const doomed = state.conversations.filter(conversation => conversation.scope === state.activeScope)
    for (const conversation of doomed) {
      void ipc.invoke('agent:discard-session', conversation.id, conversation.scope).catch((error) => {
        logFailure('Agent', 'discard conversation session failed', error, {
          conversationId: conversation.id,
          scope: conversation.scope,
        })
      })
    }
    set(current => ({
      conversations: current.conversations.filter(c => c.scope !== current.activeScope),
      activeConversationId: null,
      scopeActiveConversationIds: { ...current.scopeActiveConversationIds, [current.activeScope]: null },
    }))
  },

  beginProjectLoad: () => {
    set(state => ({
      conversations: state.conversations.filter(c => c.scope !== 'project'),
      activeScope: 'project',
      activeConversationId: null,
      scopeActiveConversationIds: { ...state.scopeActiveConversationIds, project: null },
      showHistory: false,
      activeRequestId: null,
      dataProjectSession: null,
      composerCitations: [],
    }))
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
    const conversations = archive.conversations.map(item => fromPersistedConversation(item, 'project'))
    const activeConversationId = archive.activeConversationId
      && conversations.some(conversation => conversation.id === archive.activeConversationId)
      ? archive.activeConversationId
      : conversations[0]?.id ?? null
    set(state => ({
      // 界面助手的会话与当前项目无关，保留它们。
      conversations: [...conversations, ...state.conversations.filter(c => c.scope !== 'project')],
      activeScope: 'project',
      activeConversationId,
      scopeActiveConversationIds: { ...state.scopeActiveConversationIds, project: activeConversationId },
      showHistory: false,
      activeRequestId: null,
      dataProjectSession: projectSession,
    }))
  },

  replaceConversations: (scope, archive) => {
    const conversations = archive.conversations.map(item => fromPersistedConversation(item, scope))
    const activeConversationId = archive.activeConversationId
      && conversations.some(conversation => conversation.id === archive.activeConversationId)
      ? archive.activeConversationId
      : conversations[0]?.id ?? null
    set(state => {
      const others = state.conversations.filter(c => c.scope !== scope)
      const keepCurrent = state.activeScope !== scope
      return {
        conversations: [...conversations, ...others],
        activeConversationId: keepCurrent ? state.activeConversationId : activeConversationId,
        scopeActiveConversationIds: {
          ...state.scopeActiveConversationIds,
          [scope]: activeConversationId,
          ...(keepCurrent ? { [state.activeScope]: state.activeConversationId } : {}),
        },
      }
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
    const conv = get().getActiveConversation() ?? get().createConversation()
    set(state => ({
      conversations: state.conversations.map(c =>
        c.id === conv.id ? { ...c, modelId } : c
      ),
    }))
  },

  setThinkingLevel: (thinkingLevel) => {
    const conv = get().getActiveConversation() ?? get().createConversation()
    set(state => ({
      conversations: state.conversations.map(c =>
        c.id === conv.id ? { ...c, thinkingLevel } : c
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
              void ipc.invoke('agent:discard-session', activeConv.id, activeConv.scope).catch((error) => {
                logFailure('Agent', 'discard conversation session on clear failed', error, { conversationId: activeConv.id, scope: activeConv.scope })
              })
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
    // 会话级思考等级随这一轮下发；没选时不传，主进程按 Pi 默认的 off 处理。
    const thinkingLevel = conv.thinkingLevel ?? undefined
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
      const displayName = skillDisplayName(skill, executionContext.writingLanguage)
      const inputStr = skillInvocation.input ? `\n${modelText('输入参数：', 'Arguments: ')}${skillInvocation.input}` : ''
      content = `${modelText('[用户请求调用技能：', '[The user invoked skill: ')}${skill.metadata.name} (${displayName})]${inputStr}\n\n${modelText('请根据需要通过 load_writing_skill 加载并执行该技能要求。', 'Please load and execute this skill via load_writing_skill as appropriate.')}`
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
      // 记录这一轮的在途回合（按会话索引，另一侧后台生成也能收到自己的事件）
      inflightTurns.set(convId, { assistantMsgId: assistantMsg.id, uiLocale: requestLocale })
      set({ activeRequestId: assistantMsg.id })

      logInfo('Agent', 'sending prompt', {
        conversationId: convId,
        modelId,
        thinkingLevel,
        chars: content.trim().length,
      })
      // 技能目录随系统提示词一起下发：注册表可能刚开始加载（例如刚清空会话后
      // 新建第一条），先等它，别把空目录发给模型。
      await skillRegistry.ensureLoaded()
      const result = await ipc.invoke(
        'agent:prompt',
        convId,
        content.trim(),
        modelId,
        captureAgentEditorSnapshot(),
        toAgentPromptHistory(conv.messages),
        buildAgentSkillCatalog(executionContext.writingLanguage),
        conv.scope,
        thinkingLevel,
      )
      if (!result.success) {
        logFailure('Agent', 'renderer prompt returned failure', undefined, {
          conversationId: convId,
          modelId,
          error: result.error,
        })
        updateAssistantMsg(m => ({
          ...m,
          // 主进程主动拒绝时带原因码（模型没了、上一轮还没跑完…），按码给出
          // 可读文案；未知异常仍旧只显示通用失败，不把内部文本甩进气泡。
          content: result.code
            ? describeAgentTurnRefusal(result.code, requestLocale)
            : text('生成失败，请重试。', 'Generation failed. Please try again.'),
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
    const state = get()
    const convId = state.activeConversationId
    const cancelledUiLocale = (convId ? inflightTurns.get(convId)?.uiLocale : null)
      ?? useLocaleStore.getState().locale
    const stoppedText = cancelledUiLocale === 'en-US'
      ? '\n\n_(Generation stopped)_'
      : '\n\n_（已停止生成）_'
    // 通知主进程中止当前会话的 Agent
    if (convId) {
      await ipc.invoke('agent:abort', convId)
      inflightTurns.delete(convId)
    }

    // 只关闭当前会话里正在 streaming 的消息
    set(current => ({
      activeRequestId: null,
      conversations: current.conversations.map(c => c.id !== convId
        ? c
        : {
          ...c,
          messages: c.messages.map(m =>
            m.streaming ? { ...m, streaming: false, content: m.content + stoppedText } : m
          ),
        }),
    }))
  },

  resolveToolConfirmation: (toolCallId, confirmed) => {
    const convId = get().activeConversationId
    if (convId) {
      void ipc.invoke('agent:confirm', convId, toolCallId, confirmed)
    }
  },
}))

// ===== 主进程 Agent 事件订阅 =====

/** 按会话更新在途回合的助手消息（不依赖"当前可见的是哪一个"）。 */
function updateInflightAssistantMsg(
  conversationId: string,
  updater: (msg: AgentMessage) => AgentMessage,
): void {
  const msgId = inflightTurns.get(conversationId)?.assistantMsgId
  if (!msgId) return
  useAgentStore.setState(state => ({
    conversations: state.conversations.map(c =>
      c.id === conversationId
        ? { ...c, messages: c.messages.map(m => m.id === msgId ? updater(m) : m) }
        : c
    ),
  }))
}

/**
 * 处理主进程推来的 Agent 事件：按会话定位在途回合，当前可见的是哪一个不影响。
 * 导出以便直接测试路由（渲染层监听在 window 存在时才注册）。
 */
export function handleAgentEvent({ conversationId, event }: {
  conversationId: string
  event: PiAgentEvent
}): void {
  {
    if (!inflightTurns.has(conversationId)) return
    switch (event.type) {
      case 'text_delta':
        updateInflightAssistantMsg(conversationId, m => ({ ...m, content: m.content + event.delta }))
        break
      case 'tool_call_start':
        updateInflightAssistantMsg(conversationId, m => ({
          ...m,
          toolCalls: [...(m.toolCalls ?? []), toToolCallInfo(event.call)],
        }))
        break
      case 'tool_call_confirm':
        updateInflightAssistantMsg(conversationId, m => ({
          ...m,
          toolCalls: (m.toolCalls ?? []).map(tc =>
            tc.id === event.call.id ? { ...tc, status: 'waiting_confirm' as const } : tc
          ),
        }))
        break
      case 'tool_call_complete':
        updateInflightAssistantMsg(
          conversationId,
          m => applyToolCallResult(m, event.call, currentArtifactContext()),
        )
        break
      case 'done':
        logInfo('Agent', 'renderer received done', {
          conversationId,
          chars: event.fullText.length,
        })
        updateInflightAssistantMsg(conversationId, m => ({
          ...m,
          content: event.fullText,
          streaming: false,
        }))
        inflightTurns.delete(conversationId)
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
        updateInflightAssistantMsg(conversationId, m => ({
          ...m,
          // 日志里留原始报文，界面上给人话。
          content: describeProviderFailure(
            event.message,
            inflightTurns.get(conversationId)?.uiLocale ?? useLocaleStore.getState().locale,
          ),
          streaming: false,
        }))
        inflightTurns.delete(conversationId)
        useAgentStore.setState({ activeRequestId: null })
        break
    }
  }
}

if (typeof window !== 'undefined') {
  ipc.on('agent:event', handleAgentEvent)

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
