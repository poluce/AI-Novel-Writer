import { beforeEach, describe, expect, it } from 'vitest'

import { captureAgentEditorSnapshot, resetAgentSnapshotSurfaceForTests } from '../editor-snapshot'
import { useLayoutStore } from '../../../stores/layout-store'
import { useProjectStore } from '../../../stores/project-store'

describe('captureAgentEditorSnapshot', () => {
  beforeEach(() => {
    resetAgentSnapshotSurfaceForTests()
    useProjectStore.setState({ currentProject: null, recentProjects: [] })
    useLayoutStore.setState({
      sidebarView: 'home',
      rightView: 'agent',
      bottomPanelOpen: false,
      bottomTab: 'tasks',
      settingsOpen: false,
      newProjectOpen: false,
      importNovelOpen: false,
      chapterCreationOpen: false,
    })
  })

  it('always reports whether a novel is open', () => {
    const snapshot = captureAgentEditorSnapshot()
    expect(snapshot.project).toEqual({ open: false })
    expect(snapshot.layout?.sidebarView).toBe('home')
  })

  it('records a project switch on the next capture', () => {
    captureAgentEditorSnapshot()
    useProjectStore.setState({
      currentProject: {
        id: 'p1',
        name: '潮门',
        path: 'D:\\books\\tide',
        novelConfig: {} as never,
        characterStates: '',
        createdAt: '',
        updatedAt: '',
      },
    })
    const snapshot = captureAgentEditorSnapshot()
    expect(snapshot.project).toMatchObject({ open: true, name: '潮门' })
    expect(snapshot.changes).toContainEqual({
      kind: 'project',
      from: 'closed',
      to: 'open:D:\\books\\tide',
    })
  })
})
