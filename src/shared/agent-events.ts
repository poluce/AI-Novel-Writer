/**
 * Agent 事件与渲染端动作的共享类型（主进程 → 渲染进程，可序列化）。
 */

/** Serializable tool-call lifecycle card. */
export interface PiToolCallInfo {
  id: string
  toolName: string
  arguments: unknown
  status: 'running' | 'waiting_confirm' | 'completed' | 'failed'
  error?: string
  result?: unknown
}

/** Normalized agent event forwarded from main to the renderer UI. */
export type PiAgentEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_start'; call: PiToolCallInfo }
  | { type: 'tool_call_confirm'; call: PiToolCallInfo }
  | { type: 'tool_call_complete'; call: PiToolCallInfo }
  | { type: 'done'; fullText: string }
  | { type: 'error'; message: string }

/** Serializable renderer-side action a main-process tool asks the renderer to perform. */
export type RendererAction =
  | { type: 'open_editor'; filePath: string; content: string; tabType: string; fileName: string }
  | { type: 'start_workflow'; workflow: string; chapterNumber?: number }
  | { type: 'refresh_project_config' }
  | { type: 'refresh_blueprint' }

export type RendererActionSink = (action: RendererAction) => void
