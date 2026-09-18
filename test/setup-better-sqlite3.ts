/**
 * Node 套件加载 better-sqlite3 时走 Node ABI 旁路，不覆盖 Electron 的 Release 二进制。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
require('../scripts/register-better-sqlite3-node.cjs')
