import type {
  AgentAppChange,
  AgentEditorSnapshot,
  AgentLayoutSnapshot,
  AgentProjectSnapshot,
} from '../../shared/agent-events'
import { useEditorStore } from '../../stores/editor-store'
import { useLayoutStore } from '../../stores/layout-store'
import { useMCPStore } from '../../stores/mcp-store'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'

const RECENT_PROJECT_LIMIT = 5

interface PreviousAppSurface {
  projectKey: string
  sidebarView: string
  rightView: string
  settingsOpen: boolean
  newProjectOpen: boolean
  importNovelOpen: boolean
  chapterCreationOpen: boolean
}

let previousSurface: PreviousAppSurface | null = null

function projectKeyOf(project: AgentProjectSnapshot): string {
  return project.open ? `open:${project.path ?? project.name ?? ''}` : 'closed'
}

function diffSurface(previous: PreviousAppSurface | null, next: PreviousAppSurface): AgentAppChange[] {
  if (!previous) return []
  const changes: AgentAppChange[] = []
  if (previous.projectKey !== next.projectKey) {
    changes.push({ kind: 'project', from: previous.projectKey, to: next.projectKey })
  }
  if (previous.sidebarView !== next.sidebarView) {
    changes.push({ kind: 'sidebar', from: previous.sidebarView, to: next.sidebarView })
  }
  if (previous.rightView !== next.rightView) {
    changes.push({ kind: 'right_panel', from: previous.rightView, to: next.rightView })
  }
  if (previous.settingsOpen !== next.settingsOpen) {
    changes.push({
      kind: 'settings',
      from: previous.settingsOpen ? 'open' : 'closed',
      to: next.settingsOpen ? 'open' : 'closed',
    })
  }
  const previousDialog = [
    previous.newProjectOpen && 'new_project',
    previous.importNovelOpen && 'import_novel',
    previous.chapterCreationOpen && 'chapter_creation',
  ].filter(Boolean).join(',') || 'none'
  const nextDialog = [
    next.newProjectOpen && 'new_project',
    next.importNovelOpen && 'import_novel',
    next.chapterCreationOpen && 'chapter_creation',
  ].filter(Boolean).join(',') || 'none'
  if (previousDialog !== nextDialog) {
    changes.push({ kind: 'dialog', from: previousDialog, to: nextDialog })
  }
  return changes
}

/** Capture app shell + current-project editor tabs for one Agent turn. */
export function captureAgentEditorSnapshot(): AgentEditorSnapshot {
  const projectState = useProjectStore.getState()
  const current = projectState.currentProject
  const project: AgentProjectSnapshot = current
    ? { open: true, name: current.name, path: current.path }
    : { open: false }

  const editorState = useEditorStore.getState()
  const tabs = (current
    ? editorState.tabs.filter(tab => tab.projectKey === current.path)
    : []
  ).map(tab => ({
    name: tab.name,
    type: tab.type,
    active: tab.id === editorState.activeTabId,
    unsaved: Boolean(tab.dirty),
  }))

  const workflowState = useWorkflowStore.getState()
  const run = current
    ? workflowState.activeRuns.find(item => item.projectPath === current.path)
    : undefined
  const workflow = run
    ? {
        title: run.title,
        type: run.type,
        currentStepIndex: run.currentStepIndex,
        stepCount: run.steps.length,
      }
    : undefined

  const layoutState = useLayoutStore.getState()
  const layout: AgentLayoutSnapshot = {
    sidebarView: layoutState.sidebarView,
    rightView: layoutState.rightView,
    bottomPanelOpen: layoutState.bottomPanelOpen,
    bottomTab: layoutState.bottomTab,
    settingsOpen: layoutState.settingsOpen,
    newProjectOpen: layoutState.newProjectOpen,
    importNovelOpen: layoutState.importNovelOpen,
    chapterCreationOpen: layoutState.chapterCreationOpen,
  }

  const mcpState = useMCPStore.getState()
  const mcp = {
    connectedServers: mcpState.servers.filter(server => server.status === 'connected').length,
    tools: mcpState.tools.length,
  }

  const surface: PreviousAppSurface = {
    projectKey: projectKeyOf(project),
    sidebarView: layout.sidebarView,
    rightView: layout.rightView,
    settingsOpen: layout.settingsOpen,
    newProjectOpen: layout.newProjectOpen,
    importNovelOpen: layout.importNovelOpen,
    chapterCreationOpen: layout.chapterCreationOpen,
  }
  const changes = diffSurface(previousSurface, surface)
  previousSurface = surface

  return {
    tabs,
    workflow,
    project,
    recentProjects: projectState.recentProjects
      .slice(0, RECENT_PROJECT_LIMIT)
      .map(item => ({ name: item.name })),
    layout,
    mcp,
    ...(changes.length > 0 ? { changes } : {}),
  }
}

export function resetAgentSnapshotSurfaceForTests(): void {
  previousSurface = null
}
