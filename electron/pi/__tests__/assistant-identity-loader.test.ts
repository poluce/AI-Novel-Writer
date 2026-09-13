import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { getBuiltinPromptTemplate } from '../../../src/services/prompt-templates'
import { loadAssistantWritingIdentity } from '../assistant-identity-loader'

const tempRoots: string[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

function writeIdentity(
  dir: string,
  language: 'zh-CN' | 'en-US' | 'legacy',
  systemRole: string,
): void {
  fs.mkdirSync(dir, { recursive: true })
  const builtin = getBuiltinPromptTemplate(
    'assistant_writing_identity',
    language === 'en-US' ? 'en-US' : 'zh-CN',
  )!
  const writingLanguage = language === 'legacy' ? undefined : language
  const filename = language === 'legacy'
    ? 'assistant_writing_identity.json'
    : `assistant_writing_identity.${language}.json`
  fs.writeFileSync(path.join(dir, filename), JSON.stringify({
    ...builtin,
    writingLanguage,
    systemRole,
  }), 'utf8')
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('loadAssistantWritingIdentity', () => {
  it('falls back to the built-in template when no overlays exist', () => {
    const globalPromptsDir = path.join(tempDir('vela-identity-empty-'), 'prompts')
    const template = loadAssistantWritingIdentity('zh-CN', { globalPromptsDir })
    expect(template.systemRole).toContain('你是一位经验丰富的长篇小说写作助手')
  })

  it('prefers a global overlay over the built-in template', () => {
    const globalPromptsDir = path.join(tempDir('vela-identity-global-'), 'prompts')
    writeIdentity(globalPromptsDir, 'zh-CN', '你是全局自定义助手。')
    const template = loadAssistantWritingIdentity('zh-CN', { globalPromptsDir })
    expect(template.systemRole).toBe('你是全局自定义助手。')
  })

  it('prefers a project overlay over the global overlay', () => {
    const globalPromptsDir = path.join(tempDir('vela-identity-global-lose-'), 'prompts')
    writeIdentity(globalPromptsDir, 'zh-CN', '你是全局自定义助手。')
    const projectPath = tempDir('vela-identity-project-')
    writeIdentity(path.join(projectPath, '.vela', 'prompts'), 'zh-CN', '你是本书的 continuity 编辑。')
    const template = loadAssistantWritingIdentity('zh-CN', { projectPath, globalPromptsDir })
    expect(template.systemRole).toBe('你是本书的 continuity 编辑。')
  })

  it('reads a legacy untagged Chinese file when the tagged file is absent', () => {
    const globalPromptsDir = path.join(tempDir('vela-identity-legacy-'), 'prompts')
    writeIdentity(globalPromptsDir, 'legacy', '你是旧版全局助手。')
    const template = loadAssistantWritingIdentity('zh-CN', { globalPromptsDir })
    expect(template.systemRole).toBe('你是旧版全局助手。')
  })

  it('loads the English overlay independently of the Chinese overlay', () => {
    const globalPromptsDir = path.join(tempDir('vela-identity-en-'), 'prompts')
    writeIdentity(globalPromptsDir, 'zh-CN', '你是中文助手。')
    writeIdentity(globalPromptsDir, 'en-US', 'You are the English continuity editor.')
    expect(loadAssistantWritingIdentity('en-US', { globalPromptsDir }).systemRole)
      .toBe('You are the English continuity editor.')
    expect(loadAssistantWritingIdentity('zh-CN', { globalPromptsDir }).systemRole)
      .toBe('你是中文助手。')
  })

  it('throws when the matching overlay file is corrupt', () => {
    const globalPromptsDir = path.join(tempDir('vela-identity-corrupt-'), 'prompts')
    fs.mkdirSync(globalPromptsDir, { recursive: true })
    fs.writeFileSync(
      path.join(globalPromptsDir, 'assistant_writing_identity.zh-CN.json'),
      '{not json',
      'utf8',
    )
    expect(() => loadAssistantWritingIdentity('zh-CN', { globalPromptsDir }))
      .toThrow(/无法解析|could not be parsed/)
  })
})
