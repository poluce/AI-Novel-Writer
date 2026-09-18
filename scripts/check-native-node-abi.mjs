/**
 * check-native-node-abi — 探测 Node 旁路二进制是否可用。
 *
 * 不改退出码。完整准备请用 `pnpm run prepare:native-node`（或 `pnpm test` 的 pretest）。
 */
import { nodeSidecarBindingPath, probeBetterSqlite3Binding } from './native-abi.mjs'

const sidecarPath = nodeSidecarBindingPath()
const probe = probeBetterSqlite3Binding(sidecarPath)
if (!probe.ok) {
  console.warn([
    '',
    'better-sqlite3 Node 旁路不可用，SQLite 相关测试会失败。',
    `    ${probe.diagnostic}`,
    '    请先运行：pnpm run prepare:native-node',
    '    然后直接 pnpm test（不必关应用、不必切回 Electron）。',
    '',
  ].join('\n'))
}
