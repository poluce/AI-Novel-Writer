#!/usr/bin/env node
/**
 * Compile the prompt markdown sources into TypeScript modules.
 *
 * This is the project's equivalent of Qt's `rcc`: the `.md` files under
 * src/prompts/<language>/ are the human-edited source of truth, and this step
 * emits plain string modules that every bundler in the repo can consume.
 *
 * A virtual-module trick (`import.meta.glob`) is Vite-only, but the release
 * qualification, continuity calibration, and vector-smoke scripts bundle
 * product code with esbuild, so the compiled module must be bundler-neutral.
 *
 * Usage:
 *   node scripts/generate-prompt-modules.mjs           # write the modules
 *   node scripts/generate-prompt-modules.mjs --check    # fail if out of date
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const promptsRoot = path.join(repositoryRoot, 'src', 'prompts')
const generatedRoot = path.join(promptsRoot, 'generated')
const LANGUAGES = ['zh-CN', 'en-US']

function renderModule(language, sources) {
  const entries = sources
    .map(([key, text]) => `  ${JSON.stringify(key)}: ${JSON.stringify(text)},`)
    .join('\n')
  return `/**
 * GENERATED FILE — do not edit.
 *
 * Source of truth: src/prompts/${language}/*.md
 * Regenerate with: pnpm run generate:prompts
 */
export const ${language === 'zh-CN' ? 'ZH_CN_PROMPT_SOURCES' : 'EN_US_PROMPT_SOURCES'}: Readonly<Record<string, string>> = Object.freeze({
${entries}
})
`
}

function collect(language) {
  const directory = path.join(promptsRoot, language)
  return fs.readdirSync(directory)
    .filter(name => name.endsWith('.md'))
    .sort()
    .map(name => [name.replace(/\.md$/u, ''), fs.readFileSync(path.join(directory, name), 'utf8')])
}

function main() {
  const check = process.argv.includes('--check')
  const stale = []

  for (const language of LANGUAGES) {
    const directory = path.join(promptsRoot, language)
    if (!fs.existsSync(directory)) {
      console.error(`[prompts] missing source directory: ${path.relative(repositoryRoot, directory)}`)
      process.exit(1)
    }
    const expected = renderModule(language, collect(language))
    const target = path.join(generatedRoot, `${language}.ts`)
    const actual = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null

    if (actual === expected) continue
    if (check) {
      stale.push(path.relative(repositoryRoot, target))
      continue
    }
    fs.mkdirSync(generatedRoot, { recursive: true })
    fs.writeFileSync(target, expected, 'utf8')
    console.log(`[prompts] wrote ${path.relative(repositoryRoot, target)}`)
  }

  if (check && stale.length > 0) {
    console.error('[prompts] generated modules are out of date; run `pnpm run generate:prompts`:')
    for (const file of stale) console.error(`  - ${file}`)
    process.exit(1)
  }
  if (check) console.log('[prompts] generated modules are up to date')
}

main()
