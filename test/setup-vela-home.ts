import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * 测试环境隔离守护：
 * Vitest 测试执行期间，自动将全局 VELA_HOME 导向临时沙盒目录，
 * 绝对严禁任何单元测试或集成测试读写或破坏宿主真实 ~/.vela 生产数据。
 */
if (!process.env.AI_NOVEL_VELA_HOME) {
  const testVelaHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-test-sandbox-'))
  process.env.AI_NOVEL_VELA_HOME = testVelaHome
}
