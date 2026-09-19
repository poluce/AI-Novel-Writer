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

/** 内置（数据库驱动）编辑器页面：不需要文件路径，直接打开对应页面。 */
export type BuiltinEditorTarget =
  | 'config'
  | 'blueprints'
  | 'characters'
  | 'architecture'
  | 'synopsis'

/** Serializable renderer-side action a main-process tool asks the renderer to perform. */
export type RendererAction =
  | { type: 'open_editor'; target: 'builtin'; editor: BuiltinEditorTarget }
  | { type: 'open_editor'; target: 'file'; filePath: string; content: string; fileName: string }
  | {
      type: 'replace_draft_excerpt'
      chapterNumber: number
      oldText?: string
      newText?: string
      replacements?: Array<{ old_text: string; new_text: string }>
      draftId?: number
    }
  | { type: 'refresh_project_config' }
  | { type: 'refresh_blueprint' }
  | { type: 'refresh_architecture'; section?: string }
  | { type: 'refresh_character_roster' }
  | { type: 'sync_draft_content'; chapterNumber: number; draftId: number; content: string; isNewVersion: boolean }

/** 工作流启动收据：产物卡片与工具 details 都用它，避免再解析摘要文本。 */
export interface WorkflowLaunchReceipt {
  runId: string
  status: string
  name: string
}

/** Receipt from the renderer after a blocking action actually finished (or failed). */
export type RendererActionResult =
  | { ok: true; summary: string; workflow?: WorkflowLaunchReceipt }
  | { ok: false; error: string }

export type RendererActionSink = (
  action: RendererAction,
) => void | Promise<RendererActionResult | void>

/** Renderer-owned editor/workflow facts sent with each agent prompt (L1). */
export interface AgentEditorTabSnapshot {
  name: string
  type: string
  active: boolean
  unsaved: boolean
}

export interface AgentWorkflowSnapshot {
  title: string
  type: string
  currentStepIndex: number
  stepCount: number
}

export interface AgentProjectSnapshot {
  open: boolean
  name?: string
  path?: string
}

export interface AgentLayoutSnapshot {
  sidebarView: string
  rightView: string
  bottomPanelOpen: boolean
  bottomTab: string
  settingsOpen: boolean
  newProjectOpen: boolean
  importNovelOpen: boolean
  chapterCreationOpen: boolean
}

export interface AgentAppChange {
  kind: 'project' | 'sidebar' | 'right_panel' | 'settings' | 'dialog'
  from: string
  to: string
}

export interface AgentEditorSnapshot {
  tabs: AgentEditorTabSnapshot[]
  workflow?: AgentWorkflowSnapshot
  /** App-wide shell: which book is open, which pane is active. */
  project?: AgentProjectSnapshot
  recentProjects?: Array<{ name: string }>
  layout?: AgentLayoutSnapshot
  mcp?: { connectedServers: number; tools: number }
  changes?: AgentAppChange[]
}
