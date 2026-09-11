import type { AgentEditorSnapshot } from '../../shared/agent-events'
import { useEditorStore } from '../../stores/editor-store'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'

const ACTIVE_PREVIEW_LIMIT = 500

/** Capture current-project editor tabs and the running workflow for one Agent turn. */
export function captureAgentEditorSnapshot(): AgentEditorSnapshot | undefined {
  const projectPath = useProjectStore.getState().currentProject?.path
  const editorState = useEditorStore.getState()
  const tabs = (projectPath
    ? editorState.tabs.filter(tab => tab.projectKey === projectPath)
    : []
  ).map(tab => ({
    name: tab.name,
    type: tab.type,
    active: tab.id === editorState.activeTabId,
    unsaved: Boolean(tab.dirty),
    ...(tab.id === editorState.activeTabId && tab.content
      ? { preview: tab.content.slice(0, ACTIVE_PREVIEW_LIMIT) }
      : {}),
  }))

  const workflowState = useWorkflowStore.getState()
  const run = projectPath
    ? workflowState.activeRuns.find(item => item.projectPath === projectPath)
    : undefined
  const workflow = run
    ? {
        title: run.title,
        type: run.type,
        currentStepIndex: run.currentStepIndex,
        stepCount: run.steps.length,
      }
    : undefined

  if (tabs.length === 0 && !workflow) return undefined
  return { tabs, workflow }
}
