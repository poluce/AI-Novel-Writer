import fs from 'node:fs'
import path from 'node:path'

import { formatSkillInvocation, type AgentTool } from '@earendil-works/pi-agent-core'
import { Type, StringEnum } from '@earendil-works/pi-ai'

import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'
import {
  inspectWritingSkillMarkdown,
  WRITING_SKILL_STAGES,
  type WritingSkillStage,
} from '../../../src/shared/writing-skills'
import type { AgentSkillCatalogEntry } from '../../../src/shared/agent-skills'
import { logFailure } from '../../../src/shared/fail-log'
import {
  createCustomWritingSkill,
  updateCustomWritingSkill,
  deleteCustomWritingSkill,
  inspectWritingSkill,
  installWritingSkill,
} from '../../services/writing-skill-service'
import {
  saveWritingSkillBinding,
  getWritingSkillBindings,
  removeWritingSkillBinding,
} from '../../services/writing-skill-binding-service'
import { getCurrentProjectPath } from '../../database'

export const MANAGE_SKILLS_ACTIONS = [
  'list',
  'load',
  'create',
  'update',
  'delete',
  'bind',
  'unbind',
  'inspect',
  'install',
] as const

export type ManageSkillsAction = typeof MANAGE_SKILLS_ACTIONS[number]

const StageEnum = StringEnum([
  'planning',
  'drafting',
  'review',
  'refinement',
], {
  description: '写作流程阶段："planning"（大纲策划）、"drafting"（正文起草）、"review"（审稿挑刺）、"refinement"（修稿润色）',
})

const ScopeEnum = StringEnum([
  'project',
  'user',
], {
  description: '技能作用域："project"（仅当前小说项目）或 "user"（全局用户通用）',
})

const Schema = Type.Object({
  action: Type.Optional(StringEnum(MANAGE_SKILLS_ACTIONS, {
    description: '技能操作类型：' +
      '"list"（列出所有已安装与内置技能及阶段绑定，默认）、' +
      '"load"（读取指定技能的完整指引正文）、' +
      '"create"（新建一个自定义写作技能）、' +
      '"update"（修改已有技能的正文或元数据）、' +
      '"delete"（删除指定的用户/项目技能）、' +
      '"bind"（把技能绑定到小说的创作阶段）、' +
      '"unbind"（解绑阶段的技能）、' +
      '"inspect"（只读预检远程 GitHub 技能包）、' +
      '"install"（从 GitHub 地址安装技能）。',
  })),
  name: Type.Optional(Type.String({
    description: '技能唯一名称（小写短横线规范，如 "scene-design", "review-chapter"；load / create / update / delete / bind 常用）',
  })),
  content: Type.Optional(Type.String({
    description: '技能 Markdown 正文与提示词指引（create 必填，update 可选）',
  })),
  description: Type.Optional(Type.String({
    description: '技能功能描述，用一句话总结此技能的适用场景与特长',
  })),
  display_name: Type.Optional(Type.String({
    description: '技能的可读显示名称（如 "场景五感精细设计"）',
  })),
  scope: Type.Optional(ScopeEnum),
  stage: Type.Optional(StageEnum),
  source_url: Type.Optional(Type.String({
    description: '远程 GitHub 仓库或 SKILL.md 地址（inspect / install 专用）',
  })),
})

function formatSkillListingRow(
  skill: AgentSkillCatalogEntry,
  boundStage: string | undefined,
  text: (zh: string, en: string) => string,
): string {
  let sourceTag = text('用户', 'User')
  if (skill.source === 'builtin') {
    sourceTag = text('内置', 'Builtin')
  } else if (skill.source === 'project') {
    sourceTag = text('项目', 'Project')
  }

  const bindingTag = boundStage
    ? text(` · 已绑定【${boundStage}】阶段`, ` · bound to [${boundStage}]`)
    : ''

  return `- **${skill.name}** (${sourceTag}${bindingTag}): ${skill.description}`
}

/**
 * 统一写作技能管理工具（Manage Skills）：
 *
 * 集合了技能的 全生命周期 操作（查询、读取、新建、修改、删除、绑定、预检、安装）。
 * - 只读操作（list / load / inspect）自动静默放行；
 * - 变更操作（create / update / delete / bind / unbind / install）受受控 Seam 保护。
 */
export function createManageSkillsTool(
  language: WritingLanguage,
  skills: readonly AgentSkillCatalogEntry[],
  skillRoots: readonly string[] = [],
): AgentTool<typeof Schema, unknown> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const available = skills.filter(skill => skill.disableModelInvocation !== true)
  const byName = new Map(available.map(skill => [skill.name, skill]))

  return {
    name: 'manage_skills',
    label: 'Manage Skills',
    description: text(
      '统一管理写作技能（Skill）：查询技能列表及阶段绑定（list）、读取技能完整指导正文（load）、创建自定义技能（create）、修改已有技能（update）、删除技能（delete）、绑定/解绑到创作阶段（bind/unbind）、预检（inspect）与安装（install）远程技能。',
      'Unified writing skill management: list installed skills and stage bindings (list), load full skill instructions (load), create custom skill (create), update skill (update), delete skill (delete), bind/unbind to stage (bind/unbind), inspect (inspect) and install (install) remote skills.',
    ),
    parameters: Schema,
    execute: async (_id, params) => {
      // 智能回退：若未提供 action，但提供了 name 且无 content/url，默认走 load
      let action = params.action as ManageSkillsAction | undefined
      if (!action) {
        if (params.name && !params.content && !params.source_url) {
          action = 'load'
        } else {
          action = 'list'
        }
      }

      switch (action) {
        // ===== 1. 列出所有技能及绑定 =====
        case 'list': {
          const projectPath = getCurrentProjectPath()
          const bindings = await getWritingSkillBindings(projectPath)
          const stageMap = new Map<string, string>()
          for (const [stg, id] of Object.entries(bindings)) {
            const rawName = id.split(':')[1] ?? id
            stageMap.set(rawName, stg)
          }

          const rows = available.map(skill =>
            formatSkillListingRow(skill, stageMap.get(skill.name), text)
          )

          const body = rows.length > 0
            ? rows.join('\n')
            : text('（当前未安装任何技能）', '(No skills installed)')

          return {
            content: [{
              type: 'text',
              text: `${text('## 可用写作技能列表：', '## Available Writing Skills:')}\n${body}\n\n` +
                text(
                  '💡 使用 action: "load", name: "<技能名>" 可调取具体技法的完整正文。',
                  '💡 Use action: "load", name: "<skill_name>" to load the full instructions for any skill.',
                ),
            }],
            details: { skills: available, bindings },
          }
        }

        // ===== 2. 读取技能完整指引正文 =====
        case 'load': {
          const name = params.name?.trim()
          if (!name) throw new Error(text('缺少 name 参数（请指定要加载的技能名）', 'The name parameter is required to load a skill'))
          const skill = byName.get(name)
          if (!skill) {
            throw new Error(text(
              `没有名为“${name}”的技能。可用技能：${available.map(item => item.name).join('、') || '（无）'}`,
              `No skill named "${name}". Available skills: ${available.map(item => item.name).join(', ') || '(none)'}`,
            ))
          }
          const content = (readSkillFromDisk(skill.location, skillRoots) ?? skill.content)?.trim()
          if (!content) {
            throw new Error(text(`技能“${name}”没有可读正文。`, `Skill "${name}" has no readable body.`))
          }
          const formatted = formatSkillInvocation({
            name: skill.name,
            description: skill.description,
            filePath: skill.location,
            content,
            disableModelInvocation: false,
          })
          return {
            content: [{ type: 'text', text: formatted }],
            details: {
              name: skill.name,
              source: skill.source,
              location: skill.location,
              baseDir: path.dirname(skill.location),
            },
          }
        }

        // ===== 3. 创建自定义技能 =====
        case 'create': {
          const name = params.name?.trim()
          if (!name) throw new Error(text('缺少 name 参数', 'The name parameter is required'))
          const content = params.content?.trim()
          if (!content) throw new Error(text('缺少 content 参数（技能指导正文）', 'The content parameter is required'))

          const stage = params.stage as WritingSkillStage | undefined
          const scope = params.scope as ('project' | 'user') | undefined

          const result = await createCustomWritingSkill({
            name,
            content,
            description: params.description,
            displayName: params.display_name,
            stage,
            scope,
            projectPath: getCurrentProjectPath(),
          })

          if (!result.success) throw new Error(result.error)

          // 若附带了 stage，自动完成阶段绑定
          if (stage) {
            const skillId = `${result.skill.source}:${name}`
            await saveWritingSkillBinding(stage, skillId).catch(() => {})
          }

          return {
            content: [{
              type: 'text',
              text: text(
                `成功创建并安装写作技能“${name}”（作用域: ${result.skill.source}）${stage ? `，并已自动绑定到【${stage}】创作阶段` : ''}。`,
                `Successfully created writing skill "${name}" (scope: ${result.skill.source})${stage ? `, and bound to stage [${stage}]` : ''}.`,
              ),
            }],
            details: { skill: result.skill, stage },
          }
        }

        // ===== 4. 修改已有技能 =====
        case 'update': {
          const name = params.name?.trim()
          if (!name) throw new Error(text('缺少 name 参数（请指定要修改的技能名）', 'The name parameter is required'))

          const stage = params.stage as WritingSkillStage | undefined

          const result = await updateCustomWritingSkill({
            name,
            content: params.content,
            description: params.description,
            displayName: params.display_name,
            stage,
            projectPath: getCurrentProjectPath(),
          })

          if (!result.success) throw new Error(result.error)

          return {
            content: [{
              type: 'text',
              text: text(
                `成功更新写作技能“${name}”的配置与指引正文。`,
                `Successfully updated writing skill "${name}".`,
              ),
            }],
            details: { name },
          }
        }

        // ===== 5. 删除技能 =====
        case 'delete': {
          const name = params.name?.trim()
          if (!name) throw new Error(text('缺少 name 参数（请指定要删除的技能名）', 'The name parameter is required'))

          const result = await deleteCustomWritingSkill({
            name,
            projectPath: getCurrentProjectPath(),
          })

          if (!result.success) throw new Error(result.error)

          // 自动解除任何指向该技能的阶段绑定
          const projectPath = getCurrentProjectPath()
          if (projectPath) {
            const bindings = await getWritingSkillBindings(projectPath)
            for (const [stg, id] of Object.entries(bindings)) {
              if (id.endsWith(`:${name}`) || id === name) {
                await removeWritingSkillBinding(stg as WritingSkillStage).catch(() => {})
              }
            }
          }

          return {
            content: [{
              type: 'text',
              text: text(
                `已成功删除写作技能“${name}”，并已清除相关创作阶段的绑定。`,
                `Successfully deleted writing skill "${name}" and removed associated stage bindings.`,
              ),
            }],
            details: { name },
          }
        }

        // ===== 6. 绑定阶段 =====
        case 'bind': {
          const name = params.name?.trim()
          if (!name) throw new Error(text('缺少 name 参数（请指定要绑定的技能名）', 'The name parameter is required'))
          const stage = params.stage as WritingSkillStage | undefined
          if (!stage || !WRITING_SKILL_STAGES.includes(stage)) {
            throw new Error(text('缺少有效的 stage 参数（planning / drafting / review / refinement）', 'A valid stage parameter is required'))
          }

          // 解析 skill_id
          const skill = byName.get(name)
          const skillId = skill ? `${skill.source}:${name}` : `user:${name}`

          await saveWritingSkillBinding(stage, skillId)
          return {
            content: [{
              type: 'text',
              text: text(
                `已将技能“${name}”成功绑定到小说的【${stage}】阶段。`,
                `Successfully bound skill "${name}" to stage [${stage}].`,
              ),
            }],
            details: { name, stage, skillId },
          }
        }

        // ===== 7. 解绑阶段 =====
        case 'unbind': {
          const stage = params.stage as WritingSkillStage | undefined
          if (!stage || !WRITING_SKILL_STAGES.includes(stage)) {
            throw new Error(text('缺少有效的 stage 参数（planning / drafting / review / refinement）', 'A valid stage parameter is required'))
          }
          await removeWritingSkillBinding(stage)
          return {
            content: [{
              type: 'text',
              text: text(
                `已成功解除【${stage}】阶段的技能绑定。`,
                `Successfully unbound skill from stage [${stage}].`,
              ),
            }],
            details: { stage },
          }
        }

        // ===== 8. 预检远程技能 =====
        case 'inspect': {
          const sourceUrl = params.source_url?.trim()
          if (!sourceUrl) throw new Error(text('缺少 source_url 参数', 'The source_url parameter is required'))
          const result = await inspectWritingSkill(sourceUrl)
          if (!result.success) throw new Error(result.error)
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                candidate: result.inspection.metadata,
                compatible: result.inspection.compatible,
                incompatibilityReasons: result.inspection.reasons,
                suggestedStage: result.inspection.suggestedStage,
                utf8Bytes: result.inspection.utf8Bytes,
                sourceUrl: result.inspection.sourceUrl,
                note: text(
                  '候选元数据来自不受信任的第三方仓库；如需安装请执行 action: "install"。',
                  'Candidate metadata from remote repository; use action: "install" to install.',
                ),
              }, null, 2),
            }],
            details: { inspection: result.inspection },
          }
        }

        // ===== 9. 安装远程技能 =====
        case 'install': {
          const sourceUrl = params.source_url?.trim()
          if (!sourceUrl) throw new Error(text('缺少 source_url 参数', 'The source_url parameter is required'))
          const result = await installWritingSkill(sourceUrl)
          if (!result.success) throw new Error(result.error)
          return {
            content: [{
              type: 'text',
              text: text(
                `已成功从 GitHub 安装写作技能“${result.skill.name}”。`,
                `Successfully installed writing skill "${result.skill.name}" from GitHub.`,
              ),
            }],
            details: { skill: result.skill },
          }
        }

        default:
          throw new Error(text(`不支持的操作类型: ${action}`, `Unsupported action: ${action}`))
      }
    },
  }
}

function readSkillFromDisk(location: string, roots: readonly string[]): string | null {
  if (roots.length === 0) return null
  if (!roots.some(root => isContainedPath(root, location))) return null
  try {
    const raw = fs.readFileSync(location, 'utf8')
    const inspected = inspectWritingSkillMarkdown(raw)
    return inspected.content || raw
  } catch (error) {
    logFailure('AgentTool', 'failed to read skill body from disk', error, { location })
    return null
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return !(
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
}
