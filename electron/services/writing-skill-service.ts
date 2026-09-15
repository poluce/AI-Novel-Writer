import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { app } from 'electron'

import {
  inspectWritingSkillMarkdown,
  parseGitHubWritingSkillUrl,
  type InstalledWritingSkill,
  type RemoteWritingSkillInspection,
} from '../../src/shared/writing-skills'
import { mainText } from '../i18n'
import { VELA_HOME } from '../utils/config-utils'

const WRITING_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_WRITING_SKILL_BYTES = 64 * 1024

/**
 * 技能名的 SKILL.md 规范：小写字母/数字/连字符、≤64 字符、不以连字符开头或
 * 结尾、不出现连续连字符。目录名就是技能名，安装时按它建目录。
 */
const WRITING_SKILL_SPEC_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const WRITING_SKILL_SPEC_NAME_MAX = 64

function assertSpecSkillName(name: string): void {
  if (
    name.length > WRITING_SKILL_SPEC_NAME_MAX
    || !WRITING_SKILL_SPEC_NAME.test(name)
  ) {
    throw new Error(text(
      `技能名“${name}”不符合 SKILL.md 规范：只能用小写字母、数字与连字符，长度不超过 64，且不能以连字符开头或结尾。`,
      `The skill name "${name}" does not follow the SKILL.md spec: lowercase letters, digits, and hyphens only, at most 64 characters, and it must not start or end with a hyphen.`,
    ))
  }
}

function text(zhCNText: string, enUSText: string): string {
  return mainText(app.getLocale(), zhCNText, enUSText)
}

function isContainedPath(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath)
  return !(
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  )
}

function writingSkillDirectory(name: string): string {
  if (!WRITING_SKILL_NAME.test(name) || name === '.' || name === '..') {
    throw new Error(text('写作 Skill 名称无效', 'The writing skill name is invalid'))
  }
  const root = path.join(VELA_HOME, 'skills')
  const candidate = path.resolve(root, name)
  if (!isContainedPath(root, candidate)) {
    throw new Error(text('写作 Skill 目标超出应用目录', 'The writing skill target is outside the app directory'))
  }
  return candidate
}

function ensureOwnedSkillsRoot(): string {
  if (fs.existsSync(VELA_HOME)) {
    const homeInfo = fs.lstatSync(VELA_HOME)
    if (homeInfo.isSymbolicLink() || !homeInfo.isDirectory()) {
      throw new Error(text('应用数据目录不是受信任的本地目录', 'The app data root is not a trusted local directory'))
    }
  } else {
    fs.mkdirSync(VELA_HOME, { recursive: true })
  }
  const canonicalVelaHome = fs.realpathSync.native(VELA_HOME)
  const skillsRoot = path.join(VELA_HOME, 'skills')
  if (fs.existsSync(skillsRoot)) {
    const rootInfo = fs.lstatSync(skillsRoot)
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new Error(text('用户 Skill 目录不是受信任的本地目录', 'The user skill root is not a trusted local directory'))
    }
  } else {
    fs.mkdirSync(skillsRoot)
  }
  const canonicalRoot = fs.realpathSync.native(skillsRoot)
  if (!isContainedPath(canonicalVelaHome, canonicalRoot)) {
    throw new Error(text('用户 Skill 目录超出应用目录', 'The user skill root is outside the app directory'))
  }
  return canonicalRoot
}

function ensureOwnedSkillTarget(name: string): { directory: string; filePath: string } {
  const canonicalRoot = ensureOwnedSkillsRoot()
  const requestedDirectory = writingSkillDirectory(name)
  if (fs.existsSync(requestedDirectory)) {
    const directoryInfo = fs.lstatSync(requestedDirectory)
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new Error(text('拒绝写入链接或非目录 Skill 目标', 'Refusing to write to a linked or non-directory skill target'))
    }
  } else {
    fs.mkdirSync(requestedDirectory)
  }
  const directory = fs.realpathSync.native(requestedDirectory)
  if (!isContainedPath(canonicalRoot, directory)) {
    throw new Error(text('写作 Skill 目标超出应用目录', 'The writing skill target is outside the app directory'))
  }
  const filePath = path.join(directory, 'SKILL.md')
  if (fs.existsSync(filePath)) {
    const fileInfo = fs.lstatSync(filePath)
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
      throw new Error(text('拒绝覆盖链接或非文件 SKILL.md', 'Refusing to overwrite a linked or non-file SKILL.md'))
    }
    const canonicalFile = fs.realpathSync.native(filePath)
    if (!isContainedPath(directory, canonicalFile)) {
      throw new Error(text('SKILL.md 超出 Skill 目录', 'SKILL.md is outside its skill directory'))
    }
  }
  return { directory, filePath }
}

function githubRawUrl(owner: string, repo: string, ref: string, filePath: string): string {
  const segments = [owner, repo, ref, ...filePath.split('/')].map(encodeURIComponent)
  return `https://raw.githubusercontent.com/${segments.join('/')}`
}

async function fetchGitHubWritingSkill(sourceUrl: string): Promise<{
  raw: string
  inspection: RemoteWritingSkillInspection
}> {
  const location = parseGitHubWritingSkillUrl(sourceUrl)
  let ref = location.ref
  if (!ref) {
    const repositoryResponse = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repo)}`,
      {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AI-Novel-Writer' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!repositoryResponse.ok) throw new Error(`GitHub repository lookup failed (${repositoryResponse.status})`)
    const repository = await repositoryResponse.json() as { default_branch?: unknown }
    if (typeof repository.default_branch !== 'string' || !WRITING_SKILL_NAME.test(repository.default_branch)) {
      throw new Error('GitHub returned an unsupported default branch name')
    }
    ref = repository.default_branch
  }

  const resolvedUrl = githubRawUrl(location.owner, location.repo, ref, location.path)
  const response = await fetch(resolvedUrl, {
    headers: { Accept: 'text/plain', 'User-Agent': 'AI-Novel-Writer' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`SKILL.md download failed (${response.status})`)
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_WRITING_SKILL_BYTES) throw new Error('SKILL.md is larger than 64 KiB')
  const raw = await response.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_WRITING_SKILL_BYTES) {
    throw new Error('SKILL.md is larger than 64 KiB')
  }
  const inspected = inspectWritingSkillMarkdown(raw)
  const contentSha256 = createHash('sha256').update(raw, 'utf8').digest('hex')
  const publicInspection = {
    metadata: inspected.metadata,
    compatible: inspected.compatible,
    reasons: inspected.reasons,
    suggestedStage: inspected.suggestedStage,
    utf8Bytes: inspected.utf8Bytes,
  }
  return {
    raw,
    inspection: {
      ...publicInspection,
      sourceUrl,
      resolvedUrl,
      contentSha256,
    },
  }
}

const inspectedWritingSkills = new Map<string, Pick<RemoteWritingSkillInspection, 'contentSha256' | 'resolvedUrl'>>()

export type WritingSkillInspectResult =
  | { success: true; inspection: RemoteWritingSkillInspection }
  | { success: false; error: string }

export type WritingSkillInstallResult =
  | { success: true; skill: InstalledWritingSkill }
  | { success: false; error: string }

export async function inspectWritingSkill(sourceUrl: string): Promise<WritingSkillInspectResult> {
  try {
    if (typeof sourceUrl !== 'string' || sourceUrl.length > 2_048) {
      throw new Error(text('GitHub 地址无效', 'The GitHub URL is invalid'))
    }
    const { inspection } = await fetchGitHubWritingSkill(sourceUrl)
    inspectedWritingSkills.set(sourceUrl, {
      contentSha256: inspection.contentSha256,
      resolvedUrl: inspection.resolvedUrl,
    })
    return { success: true, inspection }
  } catch (error) {
    if (typeof sourceUrl === 'string') inspectedWritingSkills.delete(sourceUrl)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function installWritingSkill(sourceUrl: string): Promise<WritingSkillInstallResult> {
  try {
    if (typeof sourceUrl !== 'string' || sourceUrl.length > 2_048) {
      throw new Error(text('GitHub 地址无效', 'The GitHub URL is invalid'))
    }
    const confirmedInspection = inspectedWritingSkills.get(sourceUrl)
    if (!confirmedInspection) {
      throw new Error(text('请先检查该 GitHub Writing Skill，再确认安装', 'Inspect this GitHub Writing Skill before confirming installation'))
    }
    inspectedWritingSkills.delete(sourceUrl)
    const { raw, inspection } = await fetchGitHubWritingSkill(sourceUrl)
    if (
      inspection.contentSha256 !== confirmedInspection.contentSha256
      || inspection.resolvedUrl !== confirmedInspection.resolvedUrl
    ) {
      throw new Error(text('Writing Skill 在检查后已发生变化，请重新检查', 'The Writing Skill changed after inspection; inspect it again'))
    }
    if (!inspection.compatible) {
      throw new Error(text(
        `该 Skill 不是自包含提示词：${inspection.reasons.join(', ')}`,
        `This is not a self-contained prompt skill: ${inspection.reasons.join(', ')}`,
      ))
    }
    // 装进来的技能名必须能通过规范校验，否则用户会装到一个永远带诊断的技能。
    assertSpecSkillName(inspection.metadata.name)
    const requestedDirectory = writingSkillDirectory(inspection.metadata.name)
    if (fs.existsSync(requestedDirectory)) {
      throw new Error(text(
        `同名 Writing Skill 已安装：${inspection.metadata.name}`,
        `A Writing Skill with this name is already installed: ${inspection.metadata.name}`,
      ))
    }
    const { filePath } = ensureOwnedSkillTarget(inspection.metadata.name)
    fs.writeFileSync(filePath, raw, { encoding: 'utf8', mode: 0o600 })
    const skill: InstalledWritingSkill = {
      name: inspection.metadata.name,
      source: 'user',
      version: inspection.metadata.version,
      language: inspection.metadata.language,
      compatible: true,
      utf8Bytes: inspection.utf8Bytes,
    }
    return { success: true, skill }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
