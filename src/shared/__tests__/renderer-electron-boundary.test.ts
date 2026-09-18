import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const srcRoot = join(process.cwd(), 'src')
const forbidden = /from ['"][^'"]*electron\//

function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === '__tests__') continue
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full))
      continue
    }
    if (!/\.(ts|tsx)$/.test(name) || name.endsWith('.test.ts') || name.endsWith('.browser.tsx')) continue
    out.push(full)
  }
  return out
}

describe('renderer / electron boundary', () => {
  it('keeps production renderer code off electron repositories and services', () => {
    const violations: string[] = []
    for (const file of listSourceFiles(srcRoot)) {
      const source = readFileSync(file, 'utf8')
      if (forbidden.test(source)) {
        violations.push(relative(process.cwd(), file).replaceAll('\\', '/'))
      }
    }
    expect(violations).toEqual([])
  })
})
