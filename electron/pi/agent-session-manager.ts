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
import type { AgentPromptHistoryTurn } from '../../src/shared/agent-conversation-archive'
import type { ModelProfile } from '../../src/shared/ipc-channels'
import type { WritingLanguage } from '../../src/shared/writing-language'
import { logFailure, logInfo } from '../../src/shared/fail-log'

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
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const profile = this.options.resolveModel(modelId)
      logInfo('Agent', 'prompt start', {
        conversationId,
        modelId,
        modelName: profile?.modelName,
        protocol: profile?.protocol,
        provider: profile?.provider,
        chars: input.length,
      })
      const session = await this.getOrCreate(conversationId, modelId, history, skills, scope)
      const language = this.options.resolveLanguage(conversationId)
      session.setEditorSnapshot(editorSnapshot)
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
      return { success: false, error: error instanceof Error ? error.message : String(error) }
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

  /** Abort every Agent session and every one-shot stream. Sessions are dropped. */
  abortAll(): void {
    for (const [conversationId, session] of [...this.sessions]) {
      session.abort()
      void this.closeSession(conversationId)
    }
    abortAllPiInFlight()
  }

  /** 关掉内存里的 harness，并让 store 忘掉这个已关闭的会话。 */
  private async closeSession(conversationId: string): Promise<void> {
    const session = this.sessions.get(conversationId)
    const store = this.stores.get(conversationId) ?? null
    this.sessions.delete(conversationId)
    this.stores.delete(conversationId)
    if (!session) return
    await session.close()
    store?.forget(conversationId)
  }

  private async getOrCreate(
    conversationId: string,
    modelId?: string,
    history?: readonly AgentPromptHistoryTurn[],
    skills?: readonly AgentSkillCatalogEntry[],
    scope: AgentScope = 'project',
  ): Promise<AgentSession> {
    const existing = this.sessions.get(conversationId)
    if (existing) return existing

    const profile = this.options.resolveModel(modelId)
    if (!profile) throw new Error('模型未找到')

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
    if (!harnessSession) throw new Error('会话存档不可用')

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
    })

    // Pi 会话为空（首次运行、旧数据、文件被删）才用渲染层发来的纯文本历史播种。
    if (history && history.length > 0 && await session.transcriptLength() === 0) {
      await session.seedHistory(history)
    }

    this.sessions.set(conversationId, session)
    this.stores.set(conversationId, store)
    registerPiInFlight(`agent:${conversationId}`, session)
    return session
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
