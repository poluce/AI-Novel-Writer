import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createOpenEditorTool } from '../open-editor.tool'
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
  it('opens a built-in page without reading any file', async () => {
    const actions: RendererAction[] = []
    const tool = createOpenEditorTool('zh-CN', (a) => { actions.push(a) })
    const result = await tool.execute('c1', { target: 'blueprints' })

    expect(actions).toEqual([{ type: 'open_editor', target: 'builtin', editor: 'blueprints' }])
    expect(readTextMock).not.toHaveBeenCalled()
    expect(result.content[0]).toMatchObject({ type: 'text', text: '已打开「章节蓝图」页面' })
  })

  it('reads a project file only for the file target', async () => {
    projectPathMock.mockReturnValue('/proj')
    assertPathMock.mockReturnValue(undefined)
    readTextMock.mockResolvedValue('文件内容')

    const actions: RendererAction[] = []
    const tool = createOpenEditorTool('zh-CN', (a) => { actions.push(a) })
    await tool.execute('c1', { target: 'file', file_path: 'notes.md' })

    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      type: 'open_editor',
      target: 'file',
      content: '文件内容',
      fileName: 'notes.md',
    })
  })

  it('requires a file path for the file target', async () => {
    const tool = createOpenEditorTool('zh-CN', () => {})
    await expect(tool.execute('c1', { target: 'file' })).rejects.toThrow('file_path')
  })

  it('accepts Chinese target aliases and normalizes to builtin editor targets', async () => {
    const actions: RendererAction[] = []
    const tool = createOpenEditorTool('zh-CN', (a) => { actions.push(a) })
    const result = await tool.execute('c1', { target: '故事架构' as never })

    expect(actions).toEqual([{ type: 'open_editor', target: 'builtin', editor: 'architecture' }])
    expect(result.content[0]).toMatchObject({ type: 'text', text: '已打开「故事架构」页面' })
  })
})

