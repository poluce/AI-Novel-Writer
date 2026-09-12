import fs from 'node:fs'
import path from 'node:path'

import { ensureVelaHome, VELA_HOME } from './config-utils'
import type { DiagnosticLogRecord } from '../../src/shared/fail-log'

const MAX_LOG_BYTES = 8 * 1024 * 1024

export function velaLogFilePath(): string {
  return path.join(VELA_HOME, 'logs', 'vela.log')
}

export function appendVelaLog(record: DiagnosticLogRecord): void {
  ensureVelaHome()
  const filePath = velaLogFilePath()
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > MAX_LOG_BYTES) {
      const rotated = `${filePath}.1`
      try {
        fs.unlinkSync(rotated)
      } catch {
        // previous rotated file may not exist
      }
      fs.renameSync(filePath, rotated)
    }
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8')
  } catch (error) {
    console.error('[Vela Log] failed to write', velaLogFilePath(), error)
  }
}
