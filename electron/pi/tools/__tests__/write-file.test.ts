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
  atomicWriteFailureCommitState: (error: unknown) => {
    if (!error || typeof error !== 'object' || !('commitState' in error)) return undefined
    const value = (error as { commitState?: unknown }).commitState
    return value === 'not_committed' || value === 'unknown' ? value : undefined
  },
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
    expect(result.details.commitState).toBe('committed')
  })

  it('returns unknown commitState instead of throwing when the write outcome is uncertain', async () => {
    projectPathMock.mockReturnValue('/proj')
    assertPathMock.mockReturnValue(undefined)
    mkdirMock.mockResolvedValue(undefined)
    writeMock.mockRejectedValue(Object.assign(new Error('helper lost'), { commitState: 'unknown' }))

    const tool = createWriteFileTool('zh-CN')
    const result = await tool.execute('c1', { file_path: 'notes.md', content: '正文' })
    const first = result.content[0]
    if (first.type === 'text') expect(first.text).toContain('请勿自动重试')
    expect(result.details.commitState).toBe('unknown')
  })

  it('throws on a clean not_committed failure so the agent may retry', async () => {
    projectPathMock.mockReturnValue('/proj')
    assertPathMock.mockReturnValue(undefined)
    mkdirMock.mockResolvedValue(undefined)
    writeMock.mockRejectedValue(Object.assign(new Error('disk full'), { commitState: 'not_committed' }))

    const tool = createWriteFileTool('zh-CN')
    await expect(tool.execute('c1', { file_path: 'notes.md', content: '正文' })).rejects.toThrow('写入失败')
  })

  it('rejects a reserved project-fact filename', async () => {
    projectPathMock.mockReturnValue('/proj')
    const tool = createWriteFileTool('zh-CN')
    await expect(tool.execute('c1', { file_path: '故事前提.md', content: 'x' })).rejects.toThrow('保留语义目标')
  })
})
