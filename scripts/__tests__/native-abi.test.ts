import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

import {
  ensureNodeSidecarBinding,
  nodeSidecarBindingPath,
  nodeSidecarKey,
} from '../native-abi.mjs'

describe('better-sqlite3 dual ABI sidecar', () => {
  it('names the Node sidecar by ABI, platform and arch', () => {
    expect(nodeSidecarKey({
      modules: '137',
      platform: 'win32',
      arch: 'x64',
    })).toBe('node-v137-win32-x64')

    expect(nodeSidecarBindingPath('/repo', 'node-v137-win32-x64').replace(/\\/g, '/')).toBe(
      '/repo/node_modules/.native-abi/better-sqlite3/node-v137-win32-x64/better_sqlite3.node',
    )
  })

  it('reuses a valid sidecar without downloading or copying Release', () => {
    const download = vi.fn()
    const copyFile = vi.fn()
    const probe = vi.fn().mockReturnValue({ ok: true, diagnostic: '' })

    expect(ensureNodeSidecarBinding({
      sidecarPath: '/sidecar/better_sqlite3.node',
      releasePath: '/release/better_sqlite3.node',
      packageRoot: '/pkg',
      probe,
      download,
      copyFile,
      mkdir: vi.fn(),
    })).toEqual({ source: 'sidecar', path: '/sidecar/better_sqlite3.node' })

    expect(download).not.toHaveBeenCalled()
    expect(copyFile).not.toHaveBeenCalled()
  })

  it('copies a Node-compatible Release binding into the sidecar', () => {
    const download = vi.fn()
    const copyFile = vi.fn()
    const mkdir = vi.fn()
    const probe = vi.fn()
      .mockReturnValueOnce({ ok: false, diagnostic: 'missing' })
      .mockReturnValueOnce({ ok: true, diagnostic: '' })
      .mockReturnValueOnce({ ok: true, diagnostic: '' })

    expect(ensureNodeSidecarBinding({
      sidecarPath: '/sidecar/better_sqlite3.node',
      releasePath: '/release/better_sqlite3.node',
      packageRoot: '/pkg',
      probe,
      download,
      copyFile,
      mkdir,
    })).toEqual({ source: 'release', path: '/sidecar/better_sqlite3.node' })

    expect(copyFile).toHaveBeenCalledWith('/release/better_sqlite3.node', '/sidecar/better_sqlite3.node')
    expect(download).not.toHaveBeenCalled()
  })

  it('downloads into the sidecar and never writes Release when both local copies are unusable', () => {
    const download = vi.fn()
    const copyFile = vi.fn()
    const probe = vi.fn()
      .mockReturnValueOnce({ ok: false, diagnostic: 'missing sidecar' })
      .mockReturnValueOnce({ ok: false, diagnostic: 'electron abi' })
      .mockReturnValueOnce({ ok: true, diagnostic: '' })

    expect(ensureNodeSidecarBinding({
      sidecarPath: '/sidecar/better_sqlite3.node',
      releasePath: '/release/better_sqlite3.node',
      packageRoot: '/pkg',
      probe,
      download,
      copyFile,
      mkdir: vi.fn(),
    })).toEqual({ source: 'download', path: '/sidecar/better_sqlite3.node' })

    expect(download).toHaveBeenCalledWith('/sidecar/better_sqlite3.node', '/pkg')
    expect(copyFile).not.toHaveBeenCalled()
  })

  it('keeps pnpm test preparing the Node sidecar instead of overwriting Electron Release', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(packageJson.scripts.pretest).toContain('scripts/prepare-native-for-node.mjs')
    expect(packageJson.scripts['prepare:native-node']).toBe('node scripts/prepare-native-for-node.mjs')
    expect(packageJson.scripts.predev).toBe('node scripts/prepare-native-for-electron.mjs')

    const testRunner = readFileSync('scripts/run-node-test-suite.mjs', 'utf8')
    expect(testRunner).toContain('prepare-native-for-node.mjs')
    expect(testRunner).not.toContain('prepare-native-for-electron.mjs')
  })
})
