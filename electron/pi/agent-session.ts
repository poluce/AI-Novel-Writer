import type { AgentMessage, AgentTool, StreamFn } from '@earendil-works/pi-agent-core'
import type { Model } from '@earendil-works/pi-ai'

import {
  createPiAgent,
  type PiAgentHandle,
} from './pi-agent'
import { buildL1AgentContext } from './agent-l1-context'
import type { AgentEditorSnapshot, PiAgentEvent } from '../../src/shared/agent-events'
import type { WritingLanguage } from '../../src/shared/writing-language'

export type { PiAgentEvent } from '../../src/shared/agent-events'

export interface AgentSessionOptions {
  /** Pre-built pi-ai runtime (see `createPiModels`). */
  model: Model<any>
  streamFn: StreamFn
  systemPrompt: string
  tools: AgentTool<any>[]
  confirmationToolNames?: ReadonlySet<string>
  language: WritingLanguage
  /** Emit a normalized event toward the renderer (IPC send in production). */
  emit: (event: PiAgentEvent) => void
}

/**
 * One long-lived Pi Agent session (main process). Bridges the Agent's
 * normalized callbacks to renderer events and turns tool confirmation into a
 * request/response round-trip: `confirm()` resolves the pending `beforeToolCall`.
 */
export class AgentSession {
  private readonly agent: PiAgentHandle
  private readonly pendingConfirmations = new Map<string, (confirmed: boolean) => void>()
  private editorSnapshot: AgentEditorSnapshot | null = null
  private readonly language: WritingLanguage

  constructor(options: AgentSessionOptions) {
    this.language = options.language
    this.agent = createPiAgent({
      model: options.model,
      streamFn: options.streamFn,
      systemPrompt: options.systemPrompt,
      tools: options.tools,
      confirmationToolNames: options.confirmationToolNames,
      transformContext: async (messages) => this.injectL1(messages),
      callbacks: {
        onTextChunk: (chunk) => options.emit({ type: 'text_delta', delta: chunk }),
        onToolCallStart: (call) => options.emit({ type: 'tool_call_start', call }),
        onToolCallConfirmRequired: (call) => new Promise<boolean>((resolve) => {
          this.pendingConfirmations.set(call.id, resolve)
          options.emit({ type: 'tool_call_confirm', call })
        }),
        onToolCallComplete: (call) => options.emit({ type: 'tool_call_complete', call }),
        onDone: (fullText) => options.emit({ type: 'done', fullText }),
        onError: (message) => options.emit({ type: 'error', message }),
      },
    })
  }

  setEditorSnapshot(snapshot: AgentEditorSnapshot | null | undefined): void {
    this.editorSnapshot = snapshot ?? null
  }

  prompt(input: string): Promise<void> {
    return this.agent.prompt(input)
  }

  private injectL1(messages: AgentMessage[]): AgentMessage[] {
    const l1 = buildL1AgentContext(this.editorSnapshot, this.language)
    if (!l1) return messages
    const injected: AgentMessage = { role: 'user', content: l1, timestamp: Date.now() }
    if (messages.length === 0) return [injected]
    return [...messages.slice(0, -1), injected, messages[messages.length - 1]]
  }

  /** Resolve a pending tool confirmation from the renderer. */
  confirm(toolCallId: string, confirmed: boolean): void {
    const resolve = this.pendingConfirmations.get(toolCallId)
    if (resolve) {
      this.pendingConfirmations.delete(toolCallId)
      resolve(confirmed)
    }
  }

  abort(): void {
    this.agent.abort()
  }

  get messages(): AgentMessage[] {
    return this.agent.messages
  }
}
