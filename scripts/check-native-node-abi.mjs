/* global process */
/**
 * check-native-node-abi — 在 `pnpm test` 之前给出可操作的 ABI 提示。
 *
 * better-sqlite3 为 Electron 编译时，vitest（Node）会加载失败，表现为几十个
 * 测试文件报 NODE_MODULE_VERSION 不匹配。这里只做一次探测并打印指引，
 * 不改变退出码，测试照常运行（CI 已经自行 prepare:native-node）。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

try {
  const Database = require('better-sqlite3')
  const db = new Database(':memory:')
  db.prepare('select 1').get()
  db.close()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('NODE_MODULE_VERSION')) {
    console.warn([
      '',
      '⚠️  better-sqlite3 原生模块与当前 Node 版本不匹配，SQLite 相关测试会失败。',
      '    本地跑完整套件请用：pnpm test:node（自动切换 ABI，跑完切回 Electron）',
      '    或手动：pnpm run prepare:native-node && pnpm test && pnpm run rebuild',
      '    仅跑不依赖 SQLite 的用例可以忽略这条提示。',
      '',
    ].join('\n'))
  }
}
