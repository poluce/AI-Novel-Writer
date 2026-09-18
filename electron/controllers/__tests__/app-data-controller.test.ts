import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  writeJsonFile: vi.fn(),
  assertCurrentProjectContext: vi.fn((_context: unknown, currentProjectPath: string | null) => ({
    rootPath: currentProjectPath ?? 'C:\\novels\\book',
  })),
  currentProjectPath: { value: 'C:\\novels\\book' as string | null },
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler)
    }),
  },
}))

vi.mock('../../i18n', () => ({
  mainText: (_locale: string, zh: string) => zh,
}))

vi.mock('../../utils/config-utils', () => ({
  VELA_HOME: 'C:\\vela-app-data',
  writeJsonFile: mocks.writeJsonFile,
}))
vi.mock('../../database', () => ({
  getCurrentProjectPath: () => mocks.currentProjectPath.value,
}))
vi.mock('../../services/project-access', () => ({
  projectAccess: {
    assertCurrentProjectContext: (context: unknown, currentProjectPath: string | null) =>
      mocks.assertCurrentProjectContext(context, currentProjectPath),
  },
}))

import { registerAppDataController } from '../app-data-controller'

function handler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}

describe('fixed app-data IPC boundary', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.writeJsonFile.mockReset()
    mocks.assertCurrentProjectContext.mockClear()
    mocks.currentProjectPath.value = 'C:\\novels\\book'
    registerAppDataController()
  })

  it('passes the template argument after the Electron event and writes only beneath VELA_HOME', async () => {
    await expect(handler('prompt:save-global')(
      { sender: { id: 7 } },
      { key: 'style-guide', content: 'keep this prompt' },
    )).resolves.toEqual({ success: true })

    expect(mocks.writeJsonFile).toHaveBeenCalledWith(
      expect.stringMatching(/vela-app-data[\\/]prompts[\\/]style-guide\.zh-CN\.json$/),
      { key: 'style-guide', content: 'keep this prompt', writingLanguage: 'zh-CN' },
    )
  })
})

describe('skill catalog IPC boundary', () => {
  const projects: string[] = []

  function temporaryProject(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-skill-ipc-'))
    projects.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of projects.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      } catch {
        // 清理失败不该让用例变红。
      }
    }
  })

  it('serves the user catalog without touching the project session', async () => {
    const catalog = await handler('skills:load-user-catalog')({ sender: { id: 7 } }) as {
      skills: unknown[]
      diagnostics: unknown[]
    }

    expect(mocks.assertCurrentProjectContext).not.toHaveBeenCalled()
    expect(Array.isArray(catalog.skills)).toBe(true)
    expect(Array.isArray(catalog.diagnostics)).toBe(true)
  })

  it('authenticates the project session before reading project skills', async () => {
    const projectPath = temporaryProject()
    mocks.currentProjectPath.value = projectPath
    const context = { projectId: 'book', projectPath }
    const catalog = await handler('skills:load-catalog')(
      { sender: { id: 7 } },
      projectPath,
      context,
    ) as { skills: Array<{ name: string; source: string }> }

    expect(mocks.assertCurrentProjectContext).toHaveBeenCalledWith(context, projectPath)
    expect(catalog.skills.map(skill => skill.name)).toEqual([])

    // 项目技能只有落在项目目录内才会被读到。
    fs.mkdirSync(path.join(projectPath, '.vela', 'skills', 'scene-craft'), { recursive: true })
    fs.writeFileSync(
      path.join(projectPath, '.vela', 'skills', 'scene-craft', 'SKILL.md'),
      '---\nname: scene-craft\ndescription: 场景塑造\n---\n正文。',
      'utf8',
    )
    const withProjectSkill = await handler('skills:load-catalog')(
      { sender: { id: 7 } },
      projectPath,
      context,
    ) as { skills: Array<{ name: string; source: string }> }

    expect(withProjectSkill.skills).toEqual([
      expect.objectContaining({ name: 'scene-craft', source: 'project' }),
    ])
  })

  it('refuses a project path that is not the current project', async () => {
    const projectPath = temporaryProject()
    mocks.currentProjectPath.value = temporaryProject()
    const context = { projectId: 'other', projectPath }
    await expect(handler('skills:load-catalog')(
      { sender: { id: 7 } },
      projectPath,
      context,
    )).rejects.toThrow(/已拒绝跨项目读写/)
  })
})
