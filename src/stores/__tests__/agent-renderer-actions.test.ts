import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { handleRendererAction } from '../../services/agent/renderer-actions'
import { applyToolCallResult } from '../agent-store'
import { resetEditorSessionStores, useEditorStore } from '../editor-store'
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
      name: 'Renderer actions',
      path: PROJECT_PATH,
      novelConfig: { writingLanguage: 'zh-CN' },
    } as never,
  })
  resetEditorSessionStores()
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

describe('tool completion → artifact cards', () => {
  const session = { projectId: 'renderer-actions', projectPath: PROJECT_PATH }
  const context = { projectPath: PROJECT_PATH, projectSession: session }

  it('appends an editor tab card and updates the tool call card in place', () => {
    const message = {
      id: 'm1',
      role: 'assistant' as const,
      content: '',
      createdAt: 0,
      toolCalls: [{
        id: 'call-1',
        toolName: 'open_editor',
        arguments: { target: 'synopsis' },
        status: 'running' as const,
      }],
      artifacts: [],
    }

    const next = applyToolCallResult(message, {
      id: 'call-1',
      toolName: 'open_editor',
      arguments: { target: 'synopsis' },
      status: 'completed',
      result: { name: '情节大纲' },
    }, context)

    expect(next.toolCalls?.[0]).toMatchObject({ id: 'call-1', status: 'completed', source: 'builtin' })
    expect(next.artifacts).toEqual([
      expect.objectContaining({ type: 'tab_opened', name: '情节大纲' }),
    ])
  })

  it('carries Pi tool details into the renderer card model', () => {
    const message = {
      id: 'm2', role: 'assistant' as const, content: '', createdAt: 0,
      toolCalls: [{ id: 'call-2', toolName: 'write', arguments: {}, status: 'running' as const }],
      artifacts: [],
    }

    const next = applyToolCallResult(message, {
      id: 'call-2',
      toolName: 'write',
      arguments: {},
      status: 'completed',
      result: { path: `${PROJECT_PATH}\\notes.md`, name: 'notes.md', commitState: 'committed' },
    }, context)

    expect(next.toolCalls?.[0].details).toMatchObject({ name: 'notes.md', commitState: 'committed' })
    expect(next.artifacts?.[0]).toMatchObject({ type: 'file_modified', name: 'notes.md' })
  })

  it('adds no card for read-only tools or when no project session is frozen', () => {
    const base = {
      id: 'm3', role: 'assistant' as const, content: '', createdAt: 0,
      toolCalls: [{ id: 'call-3', toolName: 'read_project_state', arguments: {}, status: 'running' as const }],
      artifacts: [],
    }

    const readOnly = applyToolCallResult(base, {
      id: 'call-3', toolName: 'read_project_state', arguments: {}, status: 'completed', result: { sections: ['config'] },
    }, context)
    expect(readOnly.artifacts).toEqual([])

    const noSession = applyToolCallResult(base, {
      id: 'call-3', toolName: 'write', arguments: {}, status: 'completed',
      result: { name: 'notes.md', path: 'x', commitState: 'committed' },
    }, null)
    expect(noSession.artifacts).toEqual([])
  })

  it('marks MCP tools with their own source badge', () => {
    const message = {
      id: 'm4', role: 'assistant' as const, content: '', createdAt: 0,
      toolCalls: [{ id: 'call-4', toolName: 'mcp__docs__search', arguments: {}, status: 'running' as const }],
      artifacts: [],
    }

    const next = applyToolCallResult(message, {
      id: 'call-4', toolName: 'mcp__docs__search', arguments: {}, status: 'completed', result: 'hit',
    }, context)

    expect(next.toolCalls?.[0].source).toBe('mcp')
  })
})
