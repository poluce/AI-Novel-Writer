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

function renderInternalModule(language, sources) {
  const entries = sources
    .map(([key, text]) => `  ${JSON.stringify(key)}: ${JSON.stringify(text)},`)
    .join('\n')
  return `/**
 * GENERATED FILE — do not edit.
 *
 * Source of truth: src/prompts/internal/${language}/*.md
 * Regenerate with: pnpm run generate:prompts
 */
export const ${language === 'zh-CN' ? 'ZH_CN_INTERNAL_PROMPT_SOURCES' : 'EN_US_INTERNAL_PROMPT_SOURCES'}: Readonly<Record<string, string>> = Object.freeze({
${entries}
})
`
}

/**
 * Catalog prompts keep their bytes verbatim (the loader strips the section
 * separator itself). Internal prompts are plain templates, so exactly one
 * trailing newline — the POSIX end-of-file one — is removed to match the
 * string literals they replace.
 */
function renderSharedModule(sources) {
  const entries = sources
    .map(([key, text]) => `  ${JSON.stringify(key)}: ${JSON.stringify(text)},`)
    .join('\n')
  return `/**
 * GENERATED FILE — do not edit.
 *
 * Source of truth: src/prompts/internal/shared/*.md
 * Regenerate with: pnpm run generate:prompts
 */
export const SHARED_INTERNAL_PROMPT_SOURCES: Readonly<Record<string, string>> = Object.freeze({
${entries}
})
`
}

function collect(directory, { stripTrailingNewline = false } = {}) {
  return fs.readdirSync(directory)
    .filter(name => name.endsWith('.md'))
    .sort()
    .map(name => {
      const raw = fs.readFileSync(path.join(directory, name), 'utf8')
      const text = stripTrailingNewline && raw.endsWith('\n') ? raw.slice(0, -1) : raw
      return [name.replace(/\.md$/u, ''), text]
    })
}

function emit({ check, stale, target, expected, label }) {
  const actual = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null
  if (actual === expected) return
  if (check) {
    stale.push(path.relative(repositoryRoot, target))
    return
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, expected, 'utf8')
  console.log(`[prompts] wrote ${path.relative(repositoryRoot, target)}${label ? ` (${label})` : ''}`)
}

function main() {
  const check = process.argv.includes('--check')
  const stale = []

  for (const language of LANGUAGES) {
    const catalogDirectory = path.join(promptsRoot, language)
    const internalDirectory = path.join(promptsRoot, 'internal', language)
    for (const directory of [catalogDirectory, internalDirectory]) {
      if (!fs.existsSync(directory)) {
        console.error(`[prompts] missing source directory: ${path.relative(repositoryRoot, directory)}`)
        process.exit(1)
      }
    }

    const catalogSources = collect(catalogDirectory)
    emit({
      check,
      stale,
      target: path.join(generatedRoot, `${language}.ts`),
      expected: renderModule(language, catalogSources),
      label: `${catalogSources.length} catalog templates`,
    })

    const internalSources = collect(internalDirectory, { stripTrailingNewline: true })
    emit({
      check,
      stale,
      target: path.join(generatedRoot, `internal-${language}.ts`),
      expected: renderInternalModule(language, internalSources),
      label: `${internalSources.length} internal prompts`,
    })
  }

  const sharedDirectory = path.join(promptsRoot, 'internal', 'shared')
  if (!fs.existsSync(sharedDirectory)) {
    console.error(`[prompts] missing source directory: ${path.relative(repositoryRoot, sharedDirectory)}`)
    process.exit(1)
  }
  const sharedSources = collect(sharedDirectory)
  emit({
    check,
    stale,
    target: path.join(generatedRoot, 'internal-shared.ts'),
    expected: renderSharedModule(sharedSources),
    label: `${sharedSources.length} shared internal prompts`,
  })

  if (check && stale.length > 0) {
    console.error('[prompts] generated modules are out of date; run `pnpm run generate:prompts`:')
    for (const file of stale) console.error(`  - ${file}`)
    process.exit(1)
  }
  if (check) console.log('[prompts] generated modules are up to date')
}

main()
