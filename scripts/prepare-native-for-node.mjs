/**
 * 为当前 Node ABI 准备 better-sqlite3 旁路二进制。
 *
 * 不再覆盖包内 build/Release（那是 Electron 应用用的）。应用开着时也可以跑。
 */
import { ensureNodeSidecarBinding, nodeSidecarKey } from './native-abi.mjs'

const result = ensureNodeSidecarBinding()
console.log(`Verified better-sqlite3 Node sidecar (${nodeSidecarKey()}) from ${result.source}`)
