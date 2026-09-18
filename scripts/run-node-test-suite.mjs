/* global process */
/**
 * run-node-test-suite — 本地跑完整 Node 套件。
 *
 * better-sqlite3 的 Node ABI 放在旁路目录，Electron ABI 留在包内 Release。
 * 本包装器只确保旁路存在，不再改写、也不再切回 Electron。
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
  console.error('[test:node] 准备 better-sqlite3 Node 旁路失败，测试未运行')
  process.exit(prepareNode.status ?? 1)
}

const vitestArgs = nodeArgs.length > 0 ? ['exec', 'vitest', 'run', ...nodeArgs] : ['exec', 'vitest', 'run']
// Windows 上 .cmd 垫片必须经 shell 启动，否则 spawn 会直接失败（无输出）。
const testRun = run('pnpm', vitestArgs, { shell: process.platform === 'win32' })
if (testRun.error) {
  console.error('[test:node] 启动 vitest 失败：', testRun.error.message)
}

process.exit(testRun.status ?? 1)
