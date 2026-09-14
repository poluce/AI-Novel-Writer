import type { FileWriteCommitState, ProjectSessionContext } from './ipc-channels'

/** Renderer tool-call card. Richer than the main-process PiToolCallInfo stream. */
export interface ToolCallInfo {
  id: string
  toolName: string
  arguments: Record<string, unknown>
  status: 'pending' | 'running' | 'completed' | 'failed' | 'result_unknown' | 'waiting_confirm'
  result?: string
  /** Pi 工具返回的结构化 details（产物卡片等渲染派生用）。 */
  details?: unknown
  error?: string
  commitState?: FileWriteCommitState
  source?: string
  projectSession?: ProjectSessionContext | null
}

export interface ConfigImpactBlueprintProposal {
  readonly name: 'propose_chapter_blueprint'
  readonly arguments: Record<string, unknown>
}
