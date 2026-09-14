/* global process */
/**
 * run-node-test-suite — 本地跑完整 Node 套件时自动切换原生模块 ABI。
 *
 * better-sqlite3 只能针对一种运行时编译：Electron（应用运行）或 Node
 * （vitest 运行）。`pnpm test` 默认后者会因 NODE_MODULE_VERSION 不匹配而
 * 大面积失败（CI 在测试前显式跑 prepare:native-node，本地常常忘记）。
 *
 * 这个包装器按「切到 Node → 跑测试 → 无论成败都切回 Electron」执行，
 * 避免测试中断后把开发用的 Electron 原生模块留在 Node 版本上。
 *
 * 用法：pnpm test:node [-- <vitest 参数>]
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..')

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    windowsHide: true,
    env: process.env,
    ...options,
  })
}

const nodeArgs = process.argv.slice(2)
const prepareNode = run(process.execPath, [path.join('scripts', 'prepare-native-for-node.mjs')])
if (prepareNode.status !== 0) {
  console.error('[test:node] 切换 better-sqlite3 到 Node 失败，测试未运行')
  process.exit(prepareNode.status ?? 1)
}

const vitestArgs = nodeArgs.length > 0 ? ['exec', 'vitest', 'run', ...nodeArgs] : ['exec', 'vitest', 'run']
// Windows 上 .cmd 垫片必须经 shell 启动，否则 spawn 会直接失败（无输出）。
const testRun = run('pnpm', vitestArgs, { shell: process.platform === 'win32' })
if (testRun.error) {
  console.error('[test:node] 启动 vitest 失败：', testRun.error.message)
}

// 无论测试结果如何都要把原生模块切回 Electron，否则开发中的应用会启动失败。
const restore = run(process.execPath, [path.join('scripts', 'prepare-native-for-electron.mjs')])
if (restore.status !== 0) {
  console.error('[test:node] 切回 Electron 原生模块失败，请手动运行 pnpm run rebuild')
}

process.exit(testRun.status ?? 1)
