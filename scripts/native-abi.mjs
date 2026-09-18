/* global process */
/**
 * better-sqlite3 双 ABI 共存：应用用 Electron 版（包内 build/Release），
 * Node 测试用旁路目录里的 Node 版。两边不再互相覆盖同一个 .node 文件。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
export const repositoryRoot = path.resolve(path.dirname(scriptPath), '..')

export function betterSqlite3PackageRoot(root = repositoryRoot) {
  const direct = path.join(root, 'node_modules', 'better-sqlite3')
  const manifest = path.join(direct, 'package.json')
  if (!existsSync(manifest)) {
    throw new Error(`Cannot resolve better-sqlite3 at ${direct}`)
  }
  return realpathSync(direct)
}

export function releaseBindingPath(packageRoot = betterSqlite3PackageRoot()) {
  return path.join(packageRoot, 'build', 'Release', 'better_sqlite3.node')
}

export function nodeSidecarKey({
  modules = process.versions.modules,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  return `node-v${modules}-${platform}-${arch}`
}

export function nodeSidecarBindingPath(root = repositoryRoot, key = nodeSidecarKey()) {
  return path.join(root, 'node_modules', '.native-abi', 'better-sqlite3', key, 'better_sqlite3.node')
}

/**
 * 用 nativeBinding 探测指定 .node，不走 bindings() 默认的 Release 路径，
 * 因此 Electron 版占着 Release 时也能单独验证 Node 旁路。
 */
export function probeBetterSqlite3Binding(bindingPath, packageRoot = betterSqlite3PackageRoot()) {
  if (!bindingPath || !existsSync(bindingPath)) {
    return { ok: false, diagnostic: `missing native binding: ${bindingPath ?? '(empty)'}` }
  }
  const packageRequire = createRequire(path.join(packageRoot, 'lib', 'index.js'))
  try {
    const Database = packageRequire(path.join(packageRoot, 'lib', 'index.js'))
    const db = new Database(':memory:', { nativeBinding: bindingPath })
    try {
      const result = db.prepare('select 1 as ok').get()
      if (result?.ok !== 1) {
        return { ok: false, diagnostic: 'better-sqlite3 verification query failed' }
      }
      return { ok: true, diagnostic: '' }
    } finally {
      db.close()
    }
  } catch (error) {
    return {
      ok: false,
      diagnostic: error instanceof Error ? error.message : String(error),
    }
  }
}

function defaultDownloadNodeBinding(destFile, packageRoot = betterSqlite3PackageRoot()) {
  const packageRequire = createRequire(path.join(packageRoot, 'package.json'))
  const prebuildInstall = packageRequire.resolve('prebuild-install/bin.js')
  const staging = mkdtempSync(path.join(tmpdir(), 'vela-sqlite-node-'))
  try {
    copyFileSync(path.join(packageRoot, 'package.json'), path.join(staging, 'package.json'))
    const install = spawnSync(process.execPath, [prebuildInstall], {
      cwd: staging,
      env: {
        ...process.env,
        npm_config_runtime: 'node',
        npm_config_target: process.versions.node,
      },
      encoding: 'utf8',
      stdio: 'inherit',
      windowsHide: true,
    })
    if (install.error) throw install.error
    if (install.status !== 0) {
      throw new Error(`Failed to download better-sqlite3 for Node ${process.versions.node}`)
    }
    const built = path.join(staging, 'build', 'Release', 'better_sqlite3.node')
    if (!existsSync(built)) {
      throw new Error(`prebuild-install did not produce ${built}`)
    }
    mkdirSync(path.dirname(destFile), { recursive: true })
    copyFileSync(built, destFile)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * 确保当前 Node ABI 的旁路二进制存在且可加载。不改写包内 Release
 * （那是 Electron 应用用的），因此应用开着时也能准备测试用的 Node 版。
 */
export function ensureNodeSidecarBinding({
  sidecarPath = nodeSidecarBindingPath(),
  releasePath = releaseBindingPath(),
  packageRoot = betterSqlite3PackageRoot(),
  probe = probeBetterSqlite3Binding,
  download = defaultDownloadNodeBinding,
  copyFile = copyFileSync,
  mkdir = mkdirSync,
} = {}) {
  const sidecarProbe = probe(sidecarPath, packageRoot)
  if (sidecarProbe.ok) {
    return { source: 'sidecar', path: sidecarPath }
  }

  const releaseProbe = probe(releasePath, packageRoot)
  if (releaseProbe.ok) {
    mkdir(path.dirname(sidecarPath), { recursive: true })
    copyFile(releasePath, sidecarPath)
    const copied = probe(sidecarPath, packageRoot)
    if (!copied.ok) {
      throw new Error(`Copied Node binding failed verification: ${copied.diagnostic}`)
    }
    return { source: 'release', path: sidecarPath }
  }

  download(sidecarPath, packageRoot)
  const downloaded = probe(sidecarPath, packageRoot)
  if (!downloaded.ok) {
    throw new Error(`Downloaded Node binding failed verification: ${downloaded.diagnostic}`)
  }
  return { source: 'download', path: sidecarPath }
}
