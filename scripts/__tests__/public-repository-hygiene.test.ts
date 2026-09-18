import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const prohibitedPaths = [
  'CONTEXT.md',
  'design-qa.md',
  'rule.md',
  'rule.lite.md',
  'docs/superpowers',
  'public/screenshot',
  'public/logos',
  'tsconfig.node.tsbuildinfo',
]

function gitTracked(target: string): string[] {
  const result = spawnSync('git', ['ls-files', '--', target], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ls-files failed for ${target}`)
  }
  return result.stdout.split(/\r?\n/).filter(Boolean)
}

describe('public repository hygiene', () => {
  it('does not track internal process material or generated output', () => {
    for (const target of prohibitedPaths) {
      expect(gitTracked(target), target).toEqual([])
    }
  })

  it('ignores prohibited local material before it can be staged', () => {
    const rootGitignore = readFileSync('.gitignore', 'utf8')

    for (const entry of [
      '/CONTEXT.md',
      '/docs/superpowers/',
      '/output/',
      '/public/screenshot/',
      '/public/logos/',
      '*.tsbuildinfo',
    ]) {
      expect(rootGitignore).toContain(entry)
    }
  })
})
