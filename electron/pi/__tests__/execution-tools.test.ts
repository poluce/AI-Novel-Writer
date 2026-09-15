import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { BACKGROUND_CONTEXT, ok } from '@earendil-works/pi-agent-core'
import type { ExecutionEnv } from '@earendil-works/pi-agent-core'

import { buildExecutionTools, DEFAULT_COMMAND_TIMEOUT_SECONDS, globalExecutionEnv, projectExecutionEnv } from '../execution-tools'
import type { HarnessToolContext } from '../tool-types'

const roots: string[] = []

function temporaryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-exec-tools-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // 清理失败不该让用例变红。
    }
  }
})

describe('buildExecutionTools', () => {
  it('mounts the four Pi harness execution tools', () => {
    expect(buildExecutionTools().map(tool => tool.name).sort())
      .toEqual(['bash', 'edit', 'read', 'write'])
  })

  it('gives a command without an explicit timeout the default cap', async () => {
    const calls: Array<Record<string, unknown>> = []
    const env = {
      cwd: temporaryDir(),
      exec: async (_command: string, options: Record<string, unknown>) => {
        calls.push(options)
        return ok({ exitCode: 0, truncation: { truncated: false, truncatedBy: null, totalLines: 1, totalBytes: 1, outputLines: 1, outputBytes: 1, lastLinePartial: false, firstLineExceedsLimit: false, maxLines: 2000, maxBytes: 50_000 } })
      },
    } as unknown as ExecutionEnv
    const bash = buildExecutionTools().find(tool => tool.name === 'bash')
    expect(bash).toBeDefined()

    await bash!.execute(
      'call-1',
      { command: 'echo hi' },
      () => {},
      { env } as HarnessToolContext,
      {} as never,
      BACKGROUND_CONTEXT,
    )

    expect(calls[0]?.timeout).toBe(DEFAULT_COMMAND_TIMEOUT_SECONDS)
  })

  it('keeps an explicit timeout from the model', async () => {
    const calls: Array<Record<string, unknown>> = []
    const env = {
      cwd: temporaryDir(),
      exec: async (_command: string, options: Record<string, unknown>) => {
        calls.push(options)
        return ok({ exitCode: 0, truncation: { truncated: false, truncatedBy: null, totalLines: 1, totalBytes: 1, outputLines: 1, outputBytes: 1, lastLinePartial: false, firstLineExceedsLimit: false, maxLines: 2000, maxBytes: 50_000 } })
      },
    } as unknown as ExecutionEnv
    const bash = buildExecutionTools().find(tool => tool.name === 'bash')!

    await bash.execute(
      'call-1',
      { command: 'sleep 1', timeout: 5 },
      () => {},
      { env } as HarnessToolContext,
      {} as never,
      BACKGROUND_CONTEXT,
    )

    expect(calls[0]?.timeout).toBe(5)
  })
})

describe('execution environments', () => {
  it('pins the project assistant to the project root', () => {
    const projectPath = temporaryDir()
    const env = projectExecutionEnv(projectPath)
    expect(env.cwd).toBe(projectPath)
  })

  it('gives the app assistant its own workspace and creates it on demand', () => {
    const appDataRoot = temporaryDir()
    const env = globalExecutionEnv(appDataRoot)
    expect(env.cwd).toBe(path.join(appDataRoot, 'workspace'))
    expect(fs.existsSync(env.cwd)).toBe(true)
  })
})
