import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createWriteFileTool } from '../write-file.tool'

vi.mock('../../../database', () => ({
  getCurrentProjectPath: vi.fn(),
}))
vi.mock('../../../utils/project-context', () => ({
  assertProjectFilePath: vi.fn(),
}))
vi.mock('../../../security/windows-safe-file-system', () => ({
  createSecureFileCapability: vi.fn(() => ({ rootPath: '/proj', relativePath: 'notes.md', rootIdentity: 'id' })),
  windowsSafeFileSystem: { mkdir: vi.fn(), writeTextAtomically: vi.fn() },
}))

import { getCurrentProjectPath } from '../../../database'
import { assertProjectFilePath } from '../../../utils/project-context'
import { windowsSafeFileSystem } from '../../../security/windows-safe-file-system'

const projectPathMock = getCurrentProjectPath as ReturnType<typeof vi.fn>
const assertPathMock = assertProjectFilePath as ReturnType<typeof vi.fn>
const mkdirMock = windowsSafeFileSystem.mkdir as ReturnType<typeof vi.fn>
const writeMock = windowsSafeFileSystem.writeTextAtomically as ReturnType<typeof vi.fn>

beforeEach(() => {
  projectPathMock.mockReset()
  assertPathMock.mockReset()
  mkdirMock.mockReset()
  writeMock.mockReset()
})

describe('write_file', () => {
  it('writes a file atomically and reports the character count', async () => {
    projectPathMock.mockReturnValue('/proj')
    assertPathMock.mockReturnValue(undefined)
    mkdirMock.mockResolvedValue(undefined)
    writeMock.mockResolvedValue(undefined)

    const tool = createWriteFileTool('zh-CN')
    const result = await tool.execute('c1', { file_path: 'notes.md', content: '正文' })
    const first = result.content[0]
    if (first.type === 'text') expect(first.text).toContain('文件已写入')
    expect(result.details.characters).toBe(2)
    expect(result.details.path).toContain('notes.md')
  })

  it('rejects a reserved project-fact filename', async () => {
    projectPathMock.mockReturnValue('/proj')
    const tool = createWriteFileTool('zh-CN')
    await expect(tool.execute('c1', { file_path: '故事前提.md', content: 'x' })).rejects.toThrow('保留语义目标')
  })
})
