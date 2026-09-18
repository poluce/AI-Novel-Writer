import {
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
  type ExecutionEnv,
  type Session,
  type SessionMetadata,
} from '@earendil-works/pi-agent-core'

import { AgentSession } from './agent-session'
import { abortAllPiInFlight, registerPiInFlight } from './in-flight'
import { createPiModels } from './pi-models'
import { toPiModelSamplingParams } from './pi-stream-options'
import { resolveGenerationParameters } from '../llm/generation-parameter-policy'
import { buildAgentTools, confirmationToolNames } from './tool-builder'
import type { AgentConversationStore } from './agent-conversation-store'

import type { CreativeStrategy } from '../../src/shared/reasoning-types'
import type { AgentEditorSnapshot, PiAgentEvent, RendererActionSink } from '../../src/shared/agent-events'
import type { AgentSkillCatalogEntry } from '../../src/shared/agent-skills'
import type { AgentScope } from '../../src/shared/agent-scope'
import type { AssistantThinkingLevel } from '../../src/shared/agent-runtime'
import type { AgentTurnRefusalCode } from '../../src/shared/agent-turn-refusal'
import type { AgentPromptHistoryTurn, PersistedAgentConversation } from '../../src/shared/agent-conversation-archive'
import type { ModelProfile } from '../../src/shared/ipc-channels'
import type { WritingLanguage } from '../../src/shared/writing-language'
import { logFailure, logInfo } from '../../src/shared/fail-log'

/** 会话的运行时身份：换模型或换思考等级都算换运行时，会话要重建。 */
function agentRuntimeKey(profile: ModelProfile, thinkingLevel: AssistantThinkingLevel): string {
  return `${profile.id}\u0000${profile.modelName}\u0000${thinkingLevel}`
}

/**
 * 我们自己拒绝这一轮时抛的错。
 *
 * 带上原因码，渲染层才能给出一句人能读的话；未知异常的原文不会走到界面上
 * （旧行为是统一显示"生成失败"，这里保持不放宽）。
 */
export class AgentTurnRefusal extends Error {
  constructor(readonly code: AgentTurnRefusalCode, message: string) {
    super(message)
    this.name = 'AgentTurnRefusal'
  }
}

export interface AgentSessionManagerOptions {
  /** Resolve a persisted model profile for a turn (modelId may be undefined). */
  resolveModel: (modelId: string | undefined) => ModelProfile | null
  resolveSystemPrompt: (
    conversationId: string,
    scope: AgentScope,
    skills?: readonly AgentSkillCatalogEntry[],
  ) => string
  resolveLanguage: (conversationId: string) => WritingLanguage
  /** Forward a normalized agent event toward the renderer. */
  emit: (conversationId: string, event: PiAgentEvent) => void
  rendererAction: RendererActionSink
  /** Durable Pi session for one scope; absent means memory-only. */
  resolveConversationStore?: (scope: AgentScope) => AgentConversationStore | null
  /** Pi harness 执行工具的沙箱环境；不返回就不挂这些工具。 */
  resolveToolEnvironment?: (scope: AgentScope) => ExecutionEnv | null
  /** 允许直读正文的技能根（用户级 + 项目级）；不返回就只用目录快照。 */
  resolveSkillRoots?: () => readonly string[]
  /**
   * 助手对话的创作策略；工作流路径按各自的阶段解析，助手固定用 `general`。
   * 不返回就按 `auto` 处理。
   */
  resolveCreativeStrategy?: (scope: AgentScope) => CreativeStrategy | undefined
}

/**
 * Owns one long-lived Pi Agent harness per conversation. The IPC handler
 * delegates prompt/confirm/abort here; sessions stay warm for context-cache
 * reuse and are aborted on book switch.
 */
export class AgentSessionManager {
  private readonly sessions = new Map<string, AgentSession>()
  /** 每个会话由哪个 store 提供存档，关会话时要让它忘掉这个已关闭的 session。 */
  private readonly stores = new Map<string, AgentConversationStore | null>()
  /** 会话当前的运行时身份（模型 + 思考等级），用来判断要不要重建。 */
  private readonly runtimeKeys = new Map<string, string>()
  private memoryRepo: MemorySessionRepo | null = null

  constructor(private readonly options: AgentSessionManagerOptions) {}

  async prompt(
    conversationId: string,
    input: string,
    modelId?: string,
    editorSnapshot?: AgentEditorSnapshot,
    history?: readonly AgentPromptHistoryTurn[],
    skills?: readonly AgentSkillCatalogEntry[],
    scope: AgentScope = 'project',
    thinkingLevel?: AssistantThinkingLevel,
    executionMode?: 'plan' | 'writing',
  ): Promise<{ success: boolean; error?: string; code?: AgentTurnRefusalCode }> {
    try {
      const profile = this.options.resolveModel(modelId)
      logInfo('Agent', 'prompt start', {
        conversationId,
        modelId,
        modelName: profile?.modelName,
        protocol: profile?.protocol,
        provider: profile?.provider,
        thinkingLevel: thinkingLevel ?? 'off',
        executionMode: executionMode ?? 'plan',
        chars: input.length,
      })
      const session = await this.getOrCreate(conversationId, modelId, history, skills, scope, thinkingLevel)
      const language = this.options.resolveLanguage(conversationId)
      session.setEditorSnapshot(editorSnapshot)
      session.setExecutionMode(executionMode)
      session.setSystemPrompt(this.options.resolveSystemPrompt(conversationId, scope, skills))
      await session.setTools(buildAgentTools(
        language,
        this.options.rendererAction,
        scope,
        skills,
        this.options.resolveSkillRoots?.() ?? [],
      ))
      await session.prompt(input)
      logInfo('Agent', 'prompt finished', { conversationId, modelId })
      return { success: true }
    } catch (error) {
      logFailure('Agent', 'prompt failed', error, { conversationId, modelId })
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof AgentTurnRefusal ? { code: error.code } : {}),
      }
    }
  }

  confirm(conversationId: string, toolCallId: string, confirmed: boolean): { success: boolean } {
    const session = this.sessions.get(conversationId)
    if (!session) return { success: false }
    session.confirm(toolCallId, confirmed)
    return { success: true }
  }

  abort(conversationId: string): { success: boolean } {
    const session = this.sessions.get(conversationId)
    if (!session) return { success: false }
    session.abort()
    return { success: true }
  }

  /**
   * 丢弃一个对话：内存会话与 Pi 会话存档一起删。用户删除会话时才调用，
   * 切书走 `abortAll`（保留存档，下次打开还在）。
   */
  async discard(conversationId: string, scope: AgentScope = 'project'): Promise<{ success: boolean }> {
    await this.closeSession(conversationId)
    const store = this.options.resolveConversationStore?.(scope) ?? null
    if (store) {
      try {
        await store.delete(conversationId)
      } catch (error) {
        logFailure('Agent', 'failed to delete conversation session', error, { conversationId })
      }
    }
    return { success: true }
  }

  async listConversations(scope: AgentScope = 'project'): Promise<{
    conversations: PersistedAgentConversation[]
    activeConversationId: string | null
  }> {
    const store = this.options.resolveConversationStore?.(scope) ?? null
    if (!store) return { conversations: [], activeConversationId: null }
    try {
      const conversations = await store.listConversations()
      const activeConversationId = conversations[0]?.id ?? null
      return { conversations, activeConversationId }
    } catch (error) {
      logFailure('Agent', 'failed to list conversations from store', error, { scope })
      return { conversations: [], activeConversationId: null }
    }
  }

  async renameConversation(conversationId: string, title: string, scope: AgentScope = 'project'): Promise<{ success: boolean }> {
    const store = this.options.resolveConversationStore?.(scope) ?? null
    if (!store) return { success: false }
    try {
      const success = await store.renameConversation(conversationId, title)
      return { success }
    } catch (error) {
      logFailure('Agent', 'failed to rename conversation in store', error, { conversationId, scope })
      return { success: false }
    }
  }

  /** Abort every Agent session and every one-shot stream. Sessions are dropped. */
  abortAll(): void {
    for (const [conversationId, session] of [...this.sessions]) {
      session.abort()
      void this.closeSession(conversationId)
    }
    abortAllPiInFlight()
  }

  /** 关掉内存里的 harness，并让 store 忘掉这个已关闭的会话。 */
  private async closeSession(conversationId: string): Promise<boolean> {
    const session = this.sessions.get(conversationId)
    const store = this.stores.get(conversationId) ?? null
    this.sessions.delete(conversationId)
    this.stores.delete(conversationId)
    this.runtimeKeys.delete(conversationId)
    if (!session) return true
    const closed = await session.close()
    store?.forget(conversationId)
    return closed
  }

  private async getOrCreate(
    conversationId: string,
    modelId?: string,
    history?: readonly AgentPromptHistoryTurn[],
    skills?: readonly AgentSkillCatalogEntry[],
    scope: AgentScope = 'project',
    requestedThinkingLevel?: AssistantThinkingLevel,
  ): Promise<AgentSession> {
    const existing = this.sessions.get(conversationId)
    const profile = this.options.resolveModel(modelId)
    // 档案被删掉时不让老会话跟着失效：沿用现有运行时，一个会话都没有才报错。
    if (!profile) {
      if (existing) return existing
      throw new AgentTurnRefusal('model-missing', '模型未找到')
    }

    const thinkingLevel = requestedThinkingLevel ?? 'off'
    const runtimeKey = agentRuntimeKey(profile, thinkingLevel)
    if (existing) {
      if (this.runtimeKeys.get(conversationId) === runtimeKey) return existing
      await this.rebuildSession(conversationId, existing)
    }

    // 与工作流同一条生成参数策略：助手对话固定走 general 阶段。
    const sampling = resolveGenerationParameters(profile, {
      creativeStrategy: this.options.resolveCreativeStrategy?.(scope),
      reasoningStage: 'general',
    })
    const { models, model } = createPiModels(profile, {
      modelSamplingParams: toPiModelSamplingParams(sampling),
    })
    const language = this.options.resolveLanguage(conversationId)
    const store = this.options.resolveConversationStore?.(scope) ?? null
    const harnessSession = store
      ? await store.open(conversationId, { create: true })
      : await this.openMemorySession(conversationId)
    if (!harnessSession) {
      throw new AgentTurnRefusal('session-store-unavailable', '会话存档不可用')
    }

    const executionEnv = this.options.resolveToolEnvironment?.(scope) ?? null
    const session = await AgentSession.create({
      models,
      model,
      modelIdentity: {
        modelId: profile.id,
        modelName: profile.modelName,
      },
      systemPrompt: this.options.resolveSystemPrompt(conversationId, scope, skills),
      tools: buildAgentTools(
        language,
        this.options.rendererAction,
        scope,
        skills,
        this.options.resolveSkillRoots?.() ?? [],
      ),
      confirmationToolNames: confirmationToolNames(),
      ...(executionEnv ? { executionEnv } : {}),
      sampling,
      thinkingLevel,
      // 用户没显式选等级时，产品侧的思考预算补丁照旧生效。
      applySamplingThinking: requestedThinkingLevel === undefined,
      language,
      emit: (event) => this.options.emit(conversationId, event),
      session: harnessSession,
      conversationId,
      scope,
    })
    logInfo('Agent', 'agent session opened', {
      conversationId,
      scope,
      durable: !!store,
      modelName: profile.modelName,
      thinkingLevel,
    })

    // Pi 会话为空（首次运行、旧数据、文件被删）才用渲染层发来的纯文本历史播种。
    if (history && history.length > 0 && await session.transcriptLength() === 0) {
      await session.seedHistory(history)
    }

    this.sessions.set(conversationId, session)
    this.stores.set(conversationId, store)
    this.runtimeKeys.set(conversationId, runtimeKey)
    registerPiInFlight(`agent:${conversationId}`, session)
    return session
  }

  /**
   * 换模型 / 换思考等级就地重建会话。
   *
   * 这两项都是 harness 的创建期配置（`Models` 集合与请求选项都绑在创建时），
   * 重建比原地改更不容易出错：对话正文在 store 的存档里，重开的会话照样带着
   * 完整历史，只是上下文缓存会重新建立。
   */
  private async rebuildSession(conversationId: string, existing: AgentSession): Promise<void> {
    if (existing.isBusy()) {
      throw new AgentTurnRefusal('session-busy', '这一轮还在生成，结束后再切换模型或思考等级')
    }
    logInfo('Agent', 'agent runtime changed, rebuilding session', {
      conversationId,
      previous: this.runtimeKeys.get(conversationId),
    })
    const closed = await this.closeSession(conversationId)
    if (!closed) throw new AgentTurnRefusal('switch-failed', '会话未能安全关闭，稍后再试')
  }

  /** 没有可用 store（理论上只有异常路径）时退回内存会话，保持可用而不是报错。 */
  private async openMemorySession(conversationId: string): Promise<Session<SessionMetadata>> {
    this.memoryRepo ??= new MemorySessionRepo()
    try {
      return await this.memoryRepo.create({ id: conversationId }, BACKGROUND_CONTEXT)
    } catch {
      // 内存仓库把 id 留给了已关闭的旧会话，换一个仓库重新开始。
      this.memoryRepo = new MemorySessionRepo()
      return this.memoryRepo.create({ id: conversationId }, BACKGROUND_CONTEXT)
    }
  }
}
