import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/harness/env/nodejs'

import { ConfinedExecutionEnv } from '../confined-execution-env'

const roots: string[] = []

function temporaryDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    // Windows 上刚跑过命令的目录可能还被 shell 占着，重试几次再放弃。
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // 清理失败不该让用例变红。
    }
  }
})

function buildEnv(allowed: string) {
  return new ConfinedExecutionEnv(new NodeExecutionEnv({ cwd: allowed }), [allowed])
}

describe('ConfinedExecutionEnv', () => {
  it('reads and writes inside the allowed root', async () => {
    const root = temporaryDir('vela-confined-')
    const env = buildEnv(root)

    const written = await env.writeFile(path.join(root, 'note.md'), '第三章', BACKGROUND_CONTEXT)
    expect(written.ok).toBe(true)
    const read = await env.readTextFile(path.join(root, 'note.md'), BACKGROUND_CONTEXT)
    expect(read.ok && read.value).toBe('第三章')
    const listed = await env.listDir(root, BACKGROUND_CONTEXT)
    expect(listed.ok && listed.value.map(entry => entry.name)).toContain('note.md')
  })

  it('accepts relative paths against the pinned cwd', async () => {
    const root = temporaryDir('vela-confined-')
    const env = buildEnv(root)

    await env.writeFile('draft.md', '正文', BACKGROUND_CONTEXT)
    const read = await env.readTextFile('draft.md', BACKGROUND_CONTEXT)
    expect(read.ok && read.value).toBe('正文')
  })

  it('denies reads and writes outside the allowed root', async () => {
    const root = temporaryDir('vela-confined-')
    const outside = temporaryDir('vela-outside-')
    fs.writeFileSync(path.join(outside, 'secret.txt'), '不该被读到')
    const env = buildEnv(root)

    const read = await env.readTextFile(path.join(outside, 'secret.txt'), BACKGROUND_CONTEXT)
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.error.code).toBe('permission_denied')

    const write = await env.writeFile(path.join(outside, 'new.txt'), 'x', BACKGROUND_CONTEXT)
    expect(write.ok).toBe(false)
    expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false)

    const escape = await env.readTextFile(path.join(root, '..', path.basename(outside), 'secret.txt'), BACKGROUND_CONTEXT)
    expect(escape.ok).toBe(false)

    const removed = await env.remove(outside, { recursive: true }, BACKGROUND_CONTEXT)
    expect(removed.ok).toBe(false)
    expect(fs.existsSync(outside)).toBe(true)
  })

  it('rejects a rename that would move a file out of the root', async () => {
    const root = temporaryDir('vela-confined-')
    const outside = temporaryDir('vela-outside-')
    const env = buildEnv(root)
    await env.writeFile(path.join(root, 'note.md'), '正文', BACKGROUND_CONTEXT)

    const moved = await env.renameFile(
      path.join(root, 'note.md'),
      path.join(outside, 'note.md'),
      BACKGROUND_CONTEXT,
    )
    expect(moved.ok).toBe(false)
    expect(fs.existsSync(path.join(root, 'note.md'))).toBe(true)
  })

  it('denies a symlink that points outside the root', async () => {
    const root = temporaryDir('vela-confined-')
    const outside = temporaryDir('vela-outside-')
    fs.writeFileSync(path.join(outside, 'secret.txt'), '不该被读到')
    const linkPath = path.join(root, 'link.txt')
    try {
      fs.symlinkSync(path.join(outside, 'secret.txt'), linkPath)
    } catch {
      return // 平台不支持符号链接（例如未开权限的 Windows）时跳过。
    }

    const env = buildEnv(root)
    const read = await env.readTextFile(linkPath, BACKGROUND_CONTEXT)
    expect(read.ok).toBe(false)
  })

  it('keeps cwd and shell execution on the inner environment', async () => {
    const root = temporaryDir('vela-confined-')
    const env = buildEnv(root)
    expect(env.cwd).toBe(root)

    const result = await env.exec('echo hi', { cwd: root }, BACKGROUND_CONTEXT)
    expect(result.ok).toBe(true)
  })
})
