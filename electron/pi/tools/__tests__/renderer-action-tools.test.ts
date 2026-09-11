import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createOpenEditorTool } from '../open-editor.tool'
import { createStartWorkflowTool } from '../start-workflow.tool'
import type { RendererAction } from '../../renderer-action'

vi.mock('../../../database', () => ({
  getCurrentProjectPath: vi.fn(),
}))
vi.mock('../../../utils/project-context', () => ({
  assertProjectFilePath: vi.fn(),
}))
vi.mock('../../../security/windows-safe-file-system', () => ({
  createSecureFileCapability: vi.fn(() => ({})),
  windowsSafeFileSystem: { readText: vi.fn() },
}))

import { getCurrentProjectPath } from '../../../database'
import { assertProjectFilePath } from '../../../utils/project-context'
import { windowsSafeFileSystem } from '../../../security/windows-safe-file-system'

const projectPathMock = getCurrentProjectPath as ReturnType<typeof vi.fn>
const assertPathMock = assertProjectFilePath as ReturnType<typeof vi.fn>
const readTextMock = windowsSafeFileSystem.readText as ReturnType<typeof vi.fn>

beforeEach(() => {
  projectPathMock.mockReset()
  assertPathMock.mockReset()
  readTextMock.mockReset()
})

describe('open_editor', () => {
  it('reads the file and emits an open_editor renderer action', async () => {
    projectPathMock.mockReturnValue('/proj')
    assertPathMock.mockReturnValue(undefined)
    readTextMock.mockResolvedValue('文件内容')

    const actions: RendererAction[] = []
    const tool = createOpenEditorTool('zh-CN', (a) => actions.push(a))
    await tool.execute('c1', { file_path: 'notes.md', tab_type: 'chapter' })

    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ type: 'open_editor', content: '文件内容', tabType: 'chapter' })
  })
})

describe('start_workflow', () => {
  it('emits a start_workflow renderer action', async () => {
    const actions: RendererAction[] = []
    const tool = createStartWorkflowTool('zh-CN', (a) => actions.push(a))
    await tool.execute('c1', { workflow: 'generate_draft', chapter_number: 1 })

    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ type: 'start_workflow', workflow: 'generate_draft', chapterNumber: 1 })
  })

  it('requires a chapter number for chapter workflows', async () => {
    const tool = createStartWorkflowTool('zh-CN', () => {})
    await expect(tool.execute('c1', { workflow: 'generate_draft' })).rejects.toThrow('chapter_number')
  })
})
