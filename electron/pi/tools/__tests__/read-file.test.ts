import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createReadFileTool } from '../read-file.tool'

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

describe('read_file', () => {
  it('reads a project file and returns its content', async () => {
    projectPathMock.mockReturnValue('/proj')
    assertPathMock.mockReturnValue(undefined)
    readTextMock.mockResolvedValue('文件内容')

    const tool = createReadFileTool('zh-CN')
    const result = await tool.execute('c1', { file_path: 'notes.md' })
    const first = result.content[0]
    if (first.type === 'text') expect(first.text).toBe('文件内容')
  })

  it('throws when the path escapes the project', async () => {
    projectPathMock.mockReturnValue('/proj')
    assertPathMock.mockImplementation(() => { throw new Error('outside') })

    const tool = createReadFileTool('zh-CN')
    await expect(tool.execute('c1', { file_path: '../secret.md' })).rejects.toThrow('路径越界')
  })
})
