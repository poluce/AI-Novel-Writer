import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { handleRendererAction } from '../agent-store'
import { useEditorStore } from '../editor-store'
import { useLayoutStore } from '../layout-store'
import { useProjectStore } from '../project-store'
import { useLocaleStore } from '../locale-store'

const PROJECT_PATH = 'C:\\novels\\renderer-actions'
const originalEditorState = useEditorStore.getState()
const originalLayoutState = useLayoutStore.getState()
const originalProjectState = useProjectStore.getState()
const originalLocaleState = useLocaleStore.getState()

beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
  useProjectStore.setState({
    currentProject: {
      id: 'renderer-actions',
      sessionLease: 'renderer-actions-lease',
      name: 'Renderer actions',
      path: PROJECT_PATH,
      novelConfig: { writingLanguage: 'zh-CN' },
    } as never,
  })
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useLayoutStore.setState({ sidebarOpen: true, sidebarView: 'project', activeRailItem: 'project' })
})

afterEach(() => {
  useEditorStore.setState(originalEditorState)
  useLayoutStore.setState(originalLayoutState)
  useProjectStore.setState(originalProjectState)
  useLocaleStore.setState(originalLocaleState)
})

function activeTab() {
  const state = useEditorStore.getState()
  return state.tabs.find(tab => tab.id === state.activeTabId)
}

describe('agent renderer actions', () => {
  it.each([
    ['blueprints', 'chapter-card', '章节蓝图'],
    ['characters', 'character', '角色管理'],
    ['architecture', 'world-building', '故事架构'],
    ['synopsis', 'synopsis', '情节大纲'],
  ] as const)('opens the %s builtin editor without reading a file', async (editor, type, name) => {
    await handleRendererAction({ type: 'open_editor', target: 'builtin', editor })

    expect(activeTab()).toMatchObject({ type, name, projectKey: PROJECT_PATH })
  })

  it('opens the novel configuration page as a project-scoped tab', async () => {
    await handleRendererAction({ type: 'open_editor', target: 'builtin', editor: 'config' })

    expect(activeTab()).toMatchObject({ type: 'config', name: '小说配置', projectKey: PROJECT_PATH })
    expect(useEditorStore.getState().tabs.filter(tab => tab.type === 'config')).toHaveLength(1)
  })

  it('opens a project file as a read-only view with its content', async () => {
    await handleRendererAction({
      type: 'open_editor',
      target: 'file',
      filePath: `${PROJECT_PATH}\\notes.md`,
      content: '笔记正文',
      fileName: 'notes.md',
    })

    expect(activeTab()).toMatchObject({
      type: 'outline',
      name: 'notes.md',
      filePath: `${PROJECT_PATH}\\notes.md`,
      content: '笔记正文',
      projectKey: PROJECT_PATH,
    })
  })

  it('localizes builtin page names for an English project', async () => {
    useLocaleStore.setState({ locale: 'en-US', initialized: true })
    await handleRendererAction({ type: 'open_editor', target: 'builtin', editor: 'synopsis' })

    expect(activeTab()).toMatchObject({ name: 'Plot outline' })
  })

  it('ignores unrelated actions', async () => {
    await handleRendererAction({ type: 'refresh_project_config' })

    expect(useEditorStore.getState().tabs).toEqual([])
  })
})
