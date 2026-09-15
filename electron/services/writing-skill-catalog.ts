import fs from 'node:fs'
import path from 'node:path'

import {
  BACKGROUND_CONTEXT,
  loadSourcedSkills,
  type Skill,
} from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/harness/env/nodejs'

import { inspectWritingSkillMarkdown } from '../../src/shared/writing-skills'
import type {
  WritingSkillCatalog,
  WritingSkillCatalogRecord,
  WritingSkillCatalogSource,
} from '../../src/shared/writing-skill-catalog'
import { DIR_VELA_INTERNAL } from '../../src/shared/project-paths'
import { logFailure } from '../../src/shared/fail-log'
import { VELA_HOME } from '../utils/config-utils'

export type {
  WritingSkillCatalog,
  WritingSkillCatalogDiagnostic,
  WritingSkillCatalogRecord,
  WritingSkillCatalogSource,
} from '../../src/shared/writing-skill-catalog'

/** 用户级技能根目录；不是受信任的本地目录时返回 null（不读、不建）。 */
export function userSkillsRoot(): string | null {
  const root = path.join(VELA_HOME, 'skills')
  try {
    if (!fs.existsSync(root)) return null
    const info = fs.lstatSync(root)
    if (info.isSymbolicLink() || !info.isDirectory()) return null
    return fs.realpathSync.native(root)
  } catch (error) {
    logFailure('Skill', 'failed to resolve user skill root', error, { root })
    return null
  }
}

/** 项目级技能根目录。调用方负责先做项目会话校验。 */
export function projectSkillsRoot(projectPath: string): string {
  return path.join(projectPath, DIR_VELA_INTERNAL, 'skills')
}

/**
 * 用 Pi 的加载器扫描技能目录。
 *
 * 走 `loadSourcedSkills` 而不是自家扫描，是为了拿到规范的行为：YAML
 * frontmatter、忽略文件（`.gitignore` / `.ignore` / `.fdignore`）、跳过点目录
 * 与 `node_modules`、技能根目录下直接放 `.md`、以及逐条诊断（名字不符规范、
 * 描述超长等）。应用扩展字段（`display_name` / `version` / `language` /
 * `stage`）与写作技能的兼容性判定仍由 `inspectWritingSkillMarkdown` 补上。
 */
export async function loadWritingSkillCatalog(options: {
  projectPath?: string | null
  /** 便于测试注入；默认用应用数据目录下的用户技能根。 */
  userRoot?: string | null
} = {}): Promise<WritingSkillCatalog> {
  const diagnostics: WritingSkillCatalog['diagnostics'] = []
  const inputs: Array<{ path: string; source: WritingSkillCatalogSource }> = []

  const resolvedUserRoot = options.userRoot === undefined ? userSkillsRoot() : options.userRoot
  if (resolvedUserRoot) inputs.push({ path: resolvedUserRoot, source: 'user' })

  if (options.projectPath) {
    const root = projectSkillsRoot(options.projectPath)
    if (fs.existsSync(root)) inputs.push({ path: root, source: 'project' })
  }

  if (inputs.length === 0) return { skills: [], diagnostics }

  const env = new NodeExecutionEnv({ cwd: options.projectPath ?? VELA_HOME })
  try {
    const loaded = await loadSourcedSkills(
      env,
      inputs,
      (skill, source) => toCatalogRecord(skill, source),
      BACKGROUND_CONTEXT,
    )
    for (const diagnostic of loaded.diagnostics) {
      diagnostics.push({
        code: diagnostic.code,
        message: diagnostic.message,
        path: diagnostic.path,
        source: diagnostic.source,
      })
    }
    return { skills: loaded.skills.map(entry => entry.skill), diagnostics }
  } catch (error) {
    logFailure('Skill', 'failed to load skill catalog', error, { roots: inputs.map(input => input.path) })
    diagnostics.push({
      code: 'list_failed',
      message: error instanceof Error ? error.message : String(error),
      path: inputs.map(input => input.path).join('、'),
    })
    return { skills: [], diagnostics }
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT).catch(() => {})
  }
}

/** Pi 的 `Skill` + 自家扩展字段 → 目录记录。 */
function toCatalogRecord(skill: Skill, source: WritingSkillCatalogSource): WritingSkillCatalogRecord {
  const inspected = readInspection(skill.filePath)
  return {
    name: skill.name,
    description: skill.description,
    content: skill.content,
    filePath: skill.filePath,
    baseDir: path.dirname(skill.filePath),
    source,
    ...(skill.disableModelInvocation ? { disableModelInvocation: true } : {}),
    ...(inspected
      ? {
        displayName: inspected.metadata.displayName,
        version: inspected.metadata.version,
        language: inspected.metadata.language,
        stage: inspected.metadata.stage,
        compatible: inspected.compatible,
        reasons: inspected.reasons,
        suggestedStage: inspected.suggestedStage,
        utf8Bytes: inspected.utf8Bytes,
      }
      : {
        // 读不到原文（极少见）时按最宽松处理，不因为没有扩展字段就禁用技能。
        language: 'bilingual' as const,
        compatible: true,
        reasons: [] as const,
        suggestedStage: 'drafting' as const,
        utf8Bytes: Buffer.byteLength(skill.content, 'utf8'),
      }),
  }
}

function readInspection(filePath: string) {
  try {
    return inspectWritingSkillMarkdown(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    logFailure('Skill', 'failed to inspect skill file', error, { filePath })
    return null
  }
}
