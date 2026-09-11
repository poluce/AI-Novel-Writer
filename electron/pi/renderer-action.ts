/**
 * Serializable renderer-side action a main-process tool asks the renderer to
 * perform. Forwarded over IPC (main -> renderer) by the agent session wiring.
 */
export type RendererAction =
  | { type: 'open_editor'; filePath: string; content: string; tabType: string; fileName: string }
  | { type: 'start_workflow'; workflow: string; chapterNumber?: number }
  | { type: 'refresh_project_config' }
  | { type: 'refresh_blueprint' }

export type RendererActionSink = (action: RendererAction) => void
