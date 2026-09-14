import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createOpenEditorTool } from '../open-editor.tool'
import { createStartWorkflowTool } from '../start-workflow.tool'
import { createReplaceDraftExcerptTool } from '../replace-draft-excerpt.tool'
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
})

describe('start_workflow', () => {
  it('reports success only after the renderer confirms registration', async () => {
    const actions: RendererAction[] = []
    const tool = createStartWorkflowTool('zh-CN', async (a) => {
      actions.push(a)
      return { ok: true, summary: '已启动「写稿（第 1 章）」工作流（运行 ID：run-1，状态：running）。' }
    })
    const result = await tool.execute('c1', { workflow: 'generate_draft', chapter_number: 1 })

    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ type: 'start_workflow', workflow: 'generate_draft', chapterNumber: 1 })
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: '已启动「写稿（第 1 章）」工作流（运行 ID：run-1，状态：running）。',
    })
  })

  it('returns the renderer launch error to the model', async () => {
    const tool = createStartWorkflowTool('zh-CN', async () => ({
      ok: false,
      error: 'refine 需要明确的草稿 ID 和不可变正文快照；请先打开目标草稿后从编辑器启动',
    }))
    await expect(tool.execute('c1', { workflow: 'refine', chapter_number: 1 }))
      .rejects.toThrow('草稿 ID')
  })

  it('does not report success when the renderer never returns a receipt', async () => {
    const tool = createStartWorkflowTool('zh-CN', () => {})
    await expect(tool.execute('c1', { workflow: 'generate_architecture' }))
      .rejects.toThrow('未能注册到任务中心')
  })

  it('requires a chapter number for chapter workflows', async () => {
    const tool = createStartWorkflowTool('zh-CN', async () => ({ ok: true, summary: 'no' }))
    await expect(tool.execute('c1', { workflow: 'generate_draft' })).rejects.toThrow('chapter_number')
  })
})

describe('replace_draft_excerpt', () => {
  it('reports the renderer receipt to the model', async () => {
    const tool = createReplaceDraftExcerptTool('zh-CN', async () => ({
      ok: true,
      summary: '已在第 1 章草稿中替换一处原文（3 → 5 字）。',
    }))
    const result = await tool.execute('c1', {
      chapter_number: 1,
      old_text: '他走了',
      new_text: '他离开了',
    })
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: '已在第 1 章草稿中替换一处原文（3 → 5 字）。',
    })
  })

  it('returns a unique-match failure to the model', async () => {
    const tool = createReplaceDraftExcerptTool('zh-CN', async () => ({
      ok: false,
      error: '这段原文在草稿中出现了不止一次。请多复制前后文，使匹配唯一。',
    }))
    await expect(tool.execute('c1', {
      chapter_number: 1,
      old_text: '他走了',
      new_text: '他离开了',
    })).rejects.toThrow('不止一次')
  })
})
