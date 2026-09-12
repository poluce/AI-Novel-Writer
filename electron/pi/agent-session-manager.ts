import { AgentSession } from './agent-session'
import { abortAllPiInFlight, registerPiInFlight } from './in-flight'
import { createPiModels } from './pi-models'
import { buildAgentTools, confirmationToolNames } from './tool-builder'

import type { AgentEditorSnapshot, PiAgentEvent, RendererActionSink } from '../../src/shared/agent-events'
import type { ModelProfile } from '../../src/shared/ipc-channels'
import type { WritingLanguage } from '../../src/shared/writing-language'
import { logFailure, logInfo } from '../../src/shared/fail-log'

export interface AgentSessionManagerOptions {
  /** Resolve a persisted model profile for a turn (modelId may be undefined). */
  resolveModel: (modelId: string | undefined) => ModelProfile | null
  resolveSystemPrompt: (conversationId: string) => string
  resolveLanguage: (conversationId: string) => WritingLanguage
  /** Forward a normalized agent event toward the renderer. */
  emit: (conversationId: string, event: PiAgentEvent) => void
  rendererAction: RendererActionSink
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
      const session = this.getOrCreate(conversationId, modelId)
      session.setEditorSnapshot(editorSnapshot)
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

  /** Abort every Agent session and every one-shot stream. Sessions are dropped. */
  abortAll(): void {
    for (const session of this.sessions.values()) session.abort()
    this.sessions.clear()
    abortAllPiInFlight()
  }

  private getOrCreate(conversationId: string, modelId?: string): AgentSession {
    const existing = this.sessions.get(conversationId)
    if (existing) return existing

    const profile = this.options.resolveModel(modelId)
    if (!profile) throw new Error('模型未找到')

    const { models, model } = createPiModels(profile)
    const language = this.options.resolveLanguage(conversationId)
    const tools = buildAgentTools(language, this.options.rendererAction)

    const session = new AgentSession({
      model,
      streamFn: models.streamSimple.bind(models),
      systemPrompt: this.options.resolveSystemPrompt(conversationId),
      tools,
      confirmationToolNames: confirmationToolNames(),
      language,
      emit: (event) => this.options.emit(conversationId, event),
    })
    this.sessions.set(conversationId, session)
    registerPiInFlight(`agent:${conversationId}`, session)
    return session
  }
}
