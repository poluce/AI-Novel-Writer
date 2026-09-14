import { AgentSession } from './agent-session'
import { abortAllPiInFlight, registerPiInFlight } from './in-flight'
import { createPiModels } from './pi-models'
import { buildAgentTools, confirmationToolNames } from './tool-builder'
import type { AgentConversationStore } from './agent-conversation-store'

import type { AgentEditorSnapshot, PiAgentEvent, RendererActionSink } from '../../src/shared/agent-events'
import type { AgentSkillCatalogEntry } from '../../src/shared/agent-skills'
import type { AgentPromptHistoryTurn } from '../../src/shared/agent-conversation-archive'
import type { ModelProfile } from '../../src/shared/ipc-channels'
import type { WritingLanguage } from '../../src/shared/writing-language'
import { logFailure, logInfo } from '../../src/shared/fail-log'

export interface AgentSessionManagerOptions {
  /** Resolve a persisted model profile for a turn (modelId may be undefined). */
  resolveModel: (modelId: string | undefined) => ModelProfile | null
  resolveSystemPrompt: (conversationId: string, skills?: readonly AgentSkillCatalogEntry[]) => string
  resolveLanguage: (conversationId: string) => WritingLanguage
  /** Forward a normalized agent event toward the renderer. */
  emit: (conversationId: string, event: PiAgentEvent) => void
  rendererAction: RendererActionSink
  /** Durable Pi session for the current project; absent means memory-only. */
  resolveConversationStore?: () => AgentConversationStore | null
}

/**
 * Owns one long-lived Pi Agent session per conversation. The IPC handler
 * delegates prompt/confirm/abort here; sessions stay warm for context-cache
 * reuse and are aborted on book switch.
 */
export class AgentSessionManager {
  private readonly sessions = new Map<string, AgentSession>()

  constructor(private readonly options: AgentSessionManagerOptions) {}

  async prompt(
    conversationId: string,
    input: string,
    modelId?: string,
    editorSnapshot?: AgentEditorSnapshot,
    history?: readonly AgentPromptHistoryTurn[],
    skills?: readonly AgentSkillCatalogEntry[],
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
      const session = await this.getOrCreate(conversationId, modelId, history, skills)
      session.setEditorSnapshot(editorSnapshot)
      session.setSystemPrompt(this.options.resolveSystemPrompt(conversationId, skills))
      session.setTools(buildAgentTools(this.options.resolveLanguage(conversationId), this.options.rendererAction))
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
  async discard(conversationId: string): Promise<{ success: boolean }> {
    const session = this.sessions.get(conversationId)
    if (session) {
      session.abort()
      this.sessions.delete(conversationId)
    }
    const store = this.options.resolveConversationStore?.() ?? null
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
    for (const session of this.sessions.values()) session.abort()
    this.sessions.clear()
    abortAllPiInFlight()
  }

  private async getOrCreate(
    conversationId: string,
    modelId?: string,
    history?: readonly AgentPromptHistoryTurn[],
    skills?: readonly AgentSkillCatalogEntry[],
  ): Promise<AgentSession> {
    const existing = this.sessions.get(conversationId)
    if (existing) return existing

    const profile = this.options.resolveModel(modelId)
    if (!profile) throw new Error('模型未找到')

    const { models, model } = createPiModels(profile)
    const language = this.options.resolveLanguage(conversationId)
    const tools = buildAgentTools(language, this.options.rendererAction)
    const store = this.options.resolveConversationStore?.() ?? null

    const session = new AgentSession({
      model,
      models,
      streamFn: models.streamSimple.bind(models),
      systemPrompt: this.options.resolveSystemPrompt(conversationId, skills),
      tools,
      confirmationToolNames: confirmationToolNames(),
      language,
      emit: (event) => this.options.emit(conversationId, event),
      ...(store ? { store, conversationId } : {}),
    })
    const restored = await this.restoreFromStore(session, store, conversationId)
    if (!restored && history && history.length > 0) session.restoreHistory(history)
    this.sessions.set(conversationId, session)
    registerPiInFlight(`agent:${conversationId}`, session)
    return session
  }

  /**
   * 先认 Pi 会话存档：它保住了工具回合的原始结构。存档缺失（首次运行、
   * 旧数据、文件被删）才退回渲染层发来的纯文本历史。
   */
  private async restoreFromStore(
    session: AgentSession,
    store: AgentConversationStore | null,
    conversationId: string,
  ): Promise<boolean> {
    if (!store) return false
    try {
      const snapshot = await store.load(conversationId)
      if (!snapshot) return false
      if (!session.restoreSnapshot(snapshot)) return false
      logInfo('Agent', 'restored conversation from Pi session', {
        conversationId,
        messages: snapshot.messages.length,
      })
      return true
    } catch (error) {
      logFailure('Agent', 'failed to restore conversation session', error, { conversationId })
      return false
    }
  }
}
