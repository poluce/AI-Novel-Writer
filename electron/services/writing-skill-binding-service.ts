import fs from 'node:fs'
import path from 'node:path'

import {
  inspectWritingSkillMarkdown,
  WRITING_SKILL_STAGES,
  type WritingSkillStage,
} from '../../src/shared/writing-skills'
import { VELA_HOME } from '../utils/config-utils'
import { getCurrentProjectPath } from '../database'
import { assertProjectFilePath } from '../utils/project-context'
import {
  createSecureFileCapability,
  windowsSafeFileSystem,
} from '../security/windows-safe-file-system'

/** Builtin prompt-only writing skills are always compatible. */
const BUILTIN_SKILL_NAMES = new Set([
  'long-form-continuity',
  'natural-prose-refinement',
  'review-chapter',
  'brainstorm',
  'character-analysis',
  'continuity-check',
  'writing-coach',
])

const SKILL_ID_PATTERN = /^(?:builtin|user|project):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function listUserSkills(): Array<{ name: string; content: string }> {
  const skillsDirectory = path.join(VELA_HOME, 'skills')
  if (!fs.existsSync(skillsDirectory)) return []
  const skills: Array<{ name: string; content: string }> = []
  for (const entry of fs.readdirSync(skillsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    try {
      const filePath = path.join(skillsDirectory, entry.name, 'SKILL.md')
      if (!fs.statSync(filePath).isFile()) continue
      skills.push({ name: entry.name, content: fs.readFileSync(filePath, 'utf8') })
    } catch {
      // 单个用户 Skill 无效时不阻断其余 Skill。
    }
  }
  return skills
}

function isCompatibleSkill(skillId: string): boolean {
  const [source, name] = skillId.split(':')
  if (source === 'builtin') return BUILTIN_SKILL_NAMES.has(name)
  if (source === 'user') {
    const skill = listUserSkills().find((s) => s.name === name)
    if (!skill) return false
    return inspectWritingSkillMarkdown(skill.content).compatible
  }
  return false
}

function bindingPath(projectPath: string): string {
  return `${projectPath.replace(/[\\/]$/, '')}/.vela/writing-skills.json`
}

export async function saveWritingSkillBinding(
  stage: WritingSkillStage,
  skillId: string,
): Promise<void> {
  if (!WRITING_SKILL_STAGES.includes(stage)) throw new Error('Invalid writing skill stage')
  if (!SKILL_ID_PATTERN.test(skillId)) throw new Error('Invalid writing skill identifier')
  if (!isCompatibleSkill(skillId)) {
    throw new Error('Incompatible writing skills cannot be bound to a workflow stage')
  }

  const projectPath = getCurrentProjectPath()
  if (!projectPath) throw new Error('No project is open')

  const filePath = bindingPath(projectPath)
  assertProjectFilePath(filePath, projectPath, 'writable')

  let current: Record<string, string> = {}
  try {
    const capability = createSecureFileCapability(projectPath, filePath)
    const raw = await windowsSafeFileSystem.readText(capability)
    const parsed = JSON.parse(raw) as { bindings?: Record<string, string> }
    if (parsed && typeof parsed.bindings === 'object' && parsed.bindings) {
      current = parsed.bindings
    }
  } catch {
    // 绑定文件不存在或损坏时从空绑定开始。
  }

  const bindings = { ...current, [stage]: skillId }
  const capability = createSecureFileCapability(projectPath, filePath)
  await windowsSafeFileSystem.mkdir({
    rootPath: capability.rootPath,
    relativePath: path.win32.dirname(capability.relativePath),
    rootIdentity: capability.rootIdentity,
  })
  await windowsSafeFileSystem.writeTextAtomically(
    capability,
    `${JSON.stringify({ version: 1, bindings }, null, 2)}\n`,
  )
}
