import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/harness/env/nodejs'

import { ConfinedExecutionEnv, type AtomicTextWrite } from '../confined-execution-env'

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

describe('ConfinedExecutionEnv atomic writes', () => {
  function buildAtomicEnv(allowed: string, writeTextAtomically: AtomicTextWrite) {
    return new ConfinedExecutionEnv(new NodeExecutionEnv({ cwd: allowed }), [allowed], {
      writeTextAtomically,
    })
  }

  it('routes text writes through the shared atomic writer', async () => {
    const root = temporaryDir('vela-atomic-')
    const written: Array<{ path: string; content: string }> = []
    const env = buildAtomicEnv(root, async (fullPath, content) => {
      written.push({ path: fullPath, content })
    })

    const result = await env.writeFile('draft.md', '正文', BACKGROUND_CONTEXT)

    expect(result.ok).toBe(true)
    expect(written).toEqual([{ path: path.join(root, 'draft.md'), content: '正文' }])
  })

  it('reports a failed atomic write without a commit state as a plain failure', async () => {
    const root = temporaryDir('vela-atomic-')
    const env = buildAtomicEnv(root, async () => {
      throw new Error('磁盘满了')
    })

    const result = await env.writeFile('draft.md', '正文', BACKGROUND_CONTEXT)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('写入失败')
      expect(result.error.message).not.toContain('提交态未知')
    }
    expect(env.consumeUnknownCommit('draft.md')).toBe(false)
  })

  it('tracks an unknown commit once and clears it on the next successful write', async () => {
    const root = temporaryDir('vela-atomic-')
    let fail = true
    const env = buildAtomicEnv(root, async () => {
      if (fail) throw Object.assign(new Error('助手崩了'), { commitState: 'unknown' })
    })

    const failed = await env.writeFile('draft.md', '正文', BACKGROUND_CONTEXT)
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.error.message).toContain('提交态未知')
    expect(env.consumeUnknownCommit(path.join(root, 'draft.md'))).toBe(true)
    expect(env.consumeUnknownCommit(path.join(root, 'draft.md'))).toBe(false)

    await env.writeFile('draft.md', '正文', BACKGROUND_CONTEXT)
    fail = false
    const succeeded = await env.writeFile('draft.md', '正文', BACKGROUND_CONTEXT)
    expect(succeeded.ok).toBe(true)
    expect(env.consumeUnknownCommit('draft.md')).toBe(false)
  })

  it('leaves binary writes on the inner environment', async () => {
    const root = temporaryDir('vela-atomic-')
    let atomicCalls = 0
    const env = buildAtomicEnv(root, async () => {
      atomicCalls += 1
    })

    const result = await env.writeFile('blob.bin', new Uint8Array([1, 2, 3]), BACKGROUND_CONTEXT)

    expect(result.ok).toBe(true)
    expect(atomicCalls).toBe(0)
    expect(fs.readFileSync(path.join(root, 'blob.bin'))).toEqual(Buffer.from([1, 2, 3]))
  })
})
