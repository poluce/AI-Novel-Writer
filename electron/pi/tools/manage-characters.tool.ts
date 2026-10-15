import { randomUUID } from 'node:crypto'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type, StringEnum } from '@earendil-works/pi-ai'

import { CharacterRosterRepository } from '../../repositories/character-roster-repository'
import { BlueprintRepository } from '../../repositories/blueprint-repository'
import { getProjectDb, getCurrentProjectPath } from '../../database'
import type { RendererActionSink } from '../renderer-action'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'
import {
  CHARACTER_ROSTER_SCHEMA_VERSION,
  CHARACTER_STATE_TEXT_FIELDS,
  type CharacterRosterEntry,
  type CharacterRosterRelationship,
  type CharacterRosterCharacterState,
  type CharacterRosterRename,
  type CharacterRosterSnapshot,
} from '../../../src/shared/character-roster'
import {
  normalizeCharacterRole,
  type CharacterRole,
} from '../../../src/shared/character-role'

const CharacterRoleSchema = StringEnum(
  ['protagonist', 'antagonist', 'supporting', 'minor'] as const,
  { description: 'Character role: "protagonist" (main hero), "antagonist" (villain/rival), "supporting" (key ally), or "minor" (extra/passerby).' },
)

const RelationshipItemSchema = Type.Object({
  target: Type.String({ description: '目标角色姓名（必须是已存在或同批创建的角色）' }),
  relation: Type.String({ description: '关系描述及戏剧张力/矛盾冲突（如：生死盟友、宿敌、师徒）' }),
})

const StateFieldsSchema = Type.Object({
  location: Type.Optional(Type.String({ description: '角色所处地理位置或场景' })),
  powerLevel: Type.Optional(Type.String({ description: '当前战力境界、修炼等级或能力阶段' })),
  physicalState: Type.Optional(Type.String({ description: '当前身体/生理状态（如：健康、左臂负伤、身中奇毒）' })),
  mentalState: Type.Optional(Type.String({ description: '当前精神/心理状态（如：沉着冷静、心急如焚、执念动摇）' })),
  keyItems: Type.Optional(Type.String({ description: '随身持有的关键法宝、道具、信物或武器装备' })),
  recentEvents: Type.Optional(Type.String({ description: '近章遭遇的重大事件、关键变故或战役' })),
  updatedAtChapter: Type.Optional(Type.Integer({ minimum: 0, description: '该状态发生于第几章（0 为全书开篇初始状态）' })),
})

const SingleCharacterPayloadSchema = Type.Object({
  name: Type.String({ description: '角色姓名（全书唯一）' }),
  role: Type.Optional(CharacterRoleSchema),
  gender: Type.Optional(Type.String({ description: '性别' })),
  age: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: '年龄或年龄段' })),
  appearance: Type.Optional(Type.String({ description: '外貌特征、衣着打扮与独特标志' })),
  personality: Type.Optional(Type.String({ description: '性格特征与行为偏好' })),
  background: Type.Optional(Type.String({ description: '出身背景、门派势力与过往经历' })),
  abilities: Type.Optional(Type.String({ description: '能力特长、专精功法、武器或核心技能' })),
  motivation: Type.Optional(Type.String({ description: '核心欲望、根本诉求与内在动机' })),
  arc: Type.Optional(Type.String({ description: '预期成长轨迹与角色弧光' })),
  notes: Type.Optional(Type.String({ description: '补充备忘录或暗藏伏笔' })),
  relationships: Type.Optional(Type.Array(RelationshipItemSchema, { description: '人际关系列表' })),
  currentState: Type.Optional(StateFieldsSchema),
})

export const CHARACTER_ACTIONS = [
  'read',
  'track_appearances',
  'create',
  'batch_create',
  'update',
  'rename',
  'update_relationship',
  'delete',
] as const

const Schema = Type.Object({
  action: Type.Optional(StringEnum(CHARACTER_ACTIONS, {
    description: 'Operation action: "read" (inspect roster or character, default), "track_appearances" (trace chapter appearances), "create" (add new character), "batch_create" (add group), "update" (modify profile or state), "rename" (cascade rename), "update_relationship" (update relationship), "delete" (delete character).',
  })),

  // === 查询与目标定位参数 ===
  character_name: Type.Optional(Type.String({ description: '目标角色姓名（适用于 read/update/delete/rename/track_appearances）' })),
  chapter_number: Type.Optional(Type.Integer({ minimum: 0, description: '目标章节序号。read 时用于查该章节历史状态快照；track_appearances 时用于反查该章节登场角色' })),
  role: Type.Optional(CharacterRoleSchema),
  keyword: Type.Optional(Type.String({ description: '模糊搜索关键词（匹配姓名、性格、背景、能力、备注等）' })),
  scope: Type.Optional(StringEnum(['all', 'profile', 'state'] as const, {
    description: 'Read scope: "all" (default), "profile", or "state".',
  })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: '返回的最大角色条目数量' })),

  // === 基础档案字段（create / update 通用） ===
  name: Type.Optional(Type.String({ description: '角色姓名（create 时为新建角色名）' })),
  gender: Type.Optional(Type.String({ description: '性别' })),
  age: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: '年龄' })),
  appearance: Type.Optional(Type.String({ description: '外貌描写' })),
  personality: Type.Optional(Type.String({ description: '性格特征' })),
  background: Type.Optional(Type.String({ description: '出身背景' })),
  abilities: Type.Optional(Type.String({ description: '能力专长/境界技能' })),
  motivation: Type.Optional(Type.String({ description: '核心动机/驱动力' })),
  arc: Type.Optional(Type.String({ description: '角色弧光' })),
  notes: Type.Optional(Type.String({ description: '备忘录/伏笔' })),
  relationships: Type.Optional(Type.Array(RelationshipItemSchema, { description: '人际关系列表' })),
  currentState: Type.Optional(StateFieldsSchema),

  // === 状态增量补丁（update 专用：仅需传入变化的字段，未传字段自动从上一状态继承） ===
  state_patch: Type.Optional(StateFieldsSchema),

  // === 批量创建参数 ===
  characters: Type.Optional(Type.Array(SingleCharacterPayloadSchema, { description: '批量创建的角色列表（batch_create 专用）' })),

  // === 改名参数 ===
  original_name: Type.Optional(Type.String({ description: '原角色名（rename 专用）' })),
  new_name: Type.Optional(Type.String({ description: '新角色名（rename 专用）' })),

  // === 关系局部维护参数 ===
  source_name: Type.Optional(Type.String({ description: '关系出发角色姓名（update_relationship 专用）' })),
  target_name: Type.Optional(Type.String({ description: '关系目标角色姓名（update_relationship 专用）' })),
  relation: Type.Optional(Type.String({ description: '关系描述（update_relationship 专用）' })),
  relationship_operation: Type.Optional(StringEnum(['add', 'remove'] as const, {
    description: 'Relationship operation: "add" (add or update, default) or "remove" (delete relationship).',
  })),
})

/** 判定某次 manage_characters 调用是否为写入操作。 */
export function isManageCharactersWrite(params: Record<string, unknown>): boolean {
  const rawAction = String(params.action || 'read').toLowerCase().trim()
  return !(
    rawAction === 'read'
    || rawAction === '读取'
    || rawAction === '查看'
    || rawAction === 'list'
    || rawAction === '列表'
    || rawAction === 'track_appearances'
    || rawAction === '出场追踪'
    || rawAction === '出场'
  )
}

export function createManageCharactersTool(
  language: WritingLanguage,
  rendererAction: RendererActionSink,
): AgentTool<typeof Schema> {
  const isEn = language === 'en-US'
  function text(zhCN: string, enUS: string): string {
    return writingLanguageText(language, zhCN, enUS)
  }

  const description = isEn
    ? 'All-in-one Character Management Tool: supports querying character lists, profiles, and chapter-level historical state snapshots; tracking chapter appearances and continuity; creating single or batch characters (sects/factions); partial profile and delta state updates with auto-inheritance; project-wide cascading renames; fine-grained relationship maintenance; and safe deletions.'
    : '全功能人物中枢工具：支持全书人物多维查询、单人档案、以及基于章节时间线的历史身心状态快照回溯；支持角色出场章节轨迹追踪与章节在场阵容反查；支持单角色建档与宗门/阵营群像批量建档；支持档案局部修改与状态增量Patch继承（未提供字段自动从前文继承）；支持全工程级联改名（自动同步更新关系网与所有章节蓝图）；支持人际关系网细粒度微调与安全删除。'

  return {
    name: 'manage_characters',
    label: 'Manage Characters',
    description,
    parameters: Schema,
    isWriteOperation: isManageCharactersWrite,
    execute: async (_id, params) => {
      const projectPath = getCurrentProjectPath()
      if (!projectPath) {
        throw new Error(text('未打开小说项目', 'No novel project is currently open'))
      }

      const db = getProjectDb()
      if (!db) {
        throw new Error(text('项目数据库未初始化', 'Project database is not initialized'))
      }

      const rawAction = String(params.action || 'read').toLowerCase().trim()

      if (rawAction === 'track_appearances' || rawAction === '出场追踪' || rawAction === '出场') {
        const charName = (params.character_name || params.name || '').trim()
        const targetChapter = params.chapter_number
        const allBlueprints = BlueprintRepository.getAll()

        if (charName) {
          const matchingChapters = allBlueprints
            .filter((bp) => Array.isArray(bp.characters) && bp.characters.some((c) => namesEqual(c, charName)))
            .map((bp) => bp.chapterNumber)
            .sort((a, b) => a - b)

          if (matchingChapters.length === 0) {
            return textResult(
              text(
                `角色「${charName}」在当前已规划的章节蓝图中尚未有出场记录。`,
                `Character "${charName}" has no appearance records in current chapter blueprints.`,
              ),
              { characterName: charName, totalAppearances: 0, chapters: [] },
            )
          }

          const firstChap = matchingChapters[0]
          const latestChap = matchingChapters[matchingChapters.length - 1]
          const maxPlanned = allBlueprints.length > 0
            ? Math.max(...allBlueprints.map((b) => b.chapterNumber))
            : latestChap
          const dormantGap = maxPlanned - latestChap

          let analysis = text(
            `### 角色出场轨迹：${charName}\n\n- 累计出场章节数：${matchingChapters.length} 章\n- 出场章节列表：${matchingChapters.map(c => `第 ${c} 章`).join('、')}\n- 首次登场：第 ${firstChap} 章\n- 最近登场：第 ${latestChap} 章`,
            `### Appearance Timeline: ${charName}\n\n- Total chapters: ${matchingChapters.length}\n- Chapters: ${matchingChapters.map(c => `Ch. ${c}`).join(', ')}\n- First appearance: Ch. ${firstChap}\n- Latest appearance: Ch. ${latestChap}`,
          )

          if (dormantGap >= 10) {
            analysis += text(
              `\n- 状态提示：该角色已连续 ${dormantGap} 章未在蓝图中出场，如仍为重要角色，请关注剧情推进中是否需要安排出场。`,
              `\n- Note: This character has not appeared for ${dormantGap} consecutive chapters.`,
            )
          }

          return textResult(analysis, {
            characterName: charName,
            totalAppearances: matchingChapters.length,
            chapters: matchingChapters,
            latestChapter: latestChap,
          })
        }

        if (targetChapter !== undefined) {
          const bp = BlueprintRepository.getByChapter(targetChapter)
          if (!bp) {
            return textResult(
              text(`第 ${targetChapter} 章蓝图尚未创建。`, `Chapter ${targetChapter} blueprint has not been created yet.`),
              { chapterNumber: targetChapter, characters: [] },
            )
          }

          const roster = CharacterRosterRepository.read()
          const charNames = Array.isArray(bp.characters) ? bp.characters : []

          if (charNames.length === 0) {
            return textResult(
              text(`第 ${targetChapter} 章蓝图目前未安排任何特定角色出场。`, `Chapter ${targetChapter} blueprint currently has no characters assigned.`),
              { chapterNumber: targetChapter, characters: [] },
            )
          }

          const blocks: string[] = [
            text(
              `### 第 ${targetChapter} 章出场角色阵容（共 ${charNames.length} 人）：`,
              `### Cast for Chapter ${targetChapter} (${charNames.length} characters):`,
            ),
          ]

          for (const name of charNames) {
            const entry = findEntryByName(roster.entries, name)
            if (!entry) {
              blocks.push(`- **${name}**（未建档角色）`)
              continue
            }
            let desc = `- **${entry.name}** [${formatRole(entry.role, isEn)}]`
            if (entry.currentState) {
              const state = entry.currentState
              const stateParts: string[] = []
              if (state.location) stateParts.push(text(`位置: ${state.location}`, `Location: ${state.location}`))
              if (state.powerLevel) stateParts.push(text(`境界: ${state.powerLevel}`, `Power: ${state.powerLevel}`))
              if (state.physicalState) stateParts.push(text(`状态: ${state.physicalState}`, `State: ${state.physicalState}`))
              if (state.keyItems) stateParts.push(text(`道具: ${state.keyItems}`, `Items: ${state.keyItems}`))
              if (stateParts.length > 0) {
                desc += `\n  - 最新状态（第 ${state.updatedAtChapter} 章）: ${stateParts.join(' | ')}`
              }
            }
            blocks.push(desc)
          }

          return textResult(blocks.join('\n'), { chapterNumber: targetChapter, characterNames: charNames })
        }

        throw new Error(text('执行出场追踪时，必须提供 character_name（查个人轨迹）或 chapter_number（查单章阵容）', 'Either character_name or chapter_number is required for track_appearances'))
      }

      if (rawAction === 'rename' || rawAction === '改名') {
        const originalName = (params.original_name || params.character_name || '').trim()
        const newName = (params.new_name || params.name || '').trim()

        if (!originalName || !newName) {
          throw new Error(text('改名必须同时指定原角色名 original_name 与新角色名 new_name', 'Both original_name and new_name are required for rename'))
        }
        if (namesEqual(originalName, newName)) {
          throw new Error(text('原名与新名相同，无需改名', 'The new name is identical to the original name'))
        }

        const snapshot = CharacterRosterRepository.read()
        const targetEntry = findEntryByName(snapshot.entries, originalName)
        if (!targetEntry) {
          throw new Error(text(`角色「${originalName}」不存在，无法改名`, `Character "${originalName}" does not exist`))
        }
        if (findEntryByName(snapshot.entries, newName)) {
          throw new Error(text(`新角色名「${newName}」已被占用`, `Character name "${newName}" is already taken`))
        }

        const updatedEntries = snapshot.entries.map((entry) => ({
          ...entry,
          name: namesEqual(entry.name, originalName) ? newName : entry.name,
          relationships: entry.relationships.map((rel) => (
            namesEqual(rel.target, originalName) ? { ...rel, target: newName } : rel
          )),
        }))

        commitRoster(snapshot, updatedEntries, [{ originalName: targetEntry.name, newName }])
        await rendererAction({ type: 'refresh_character_roster' })
        await rendererAction({ type: 'refresh_blueprint' })

        return textResult(
          text(
            `角色已成功更名：「${targetEntry.name}」→「${newName}」。\n全书人际关系网及章节蓝图出场名单已完成级联同步。`,
            `Character renamed: "${targetEntry.name}" → "${newName}". All relationships and chapter blueprints updated.`,
          ),
          { originalName: targetEntry.name, newName },
        )
      }

      if (rawAction === 'update_relationship' || rawAction === '关系维护') {
        const sourceName = (params.source_name || params.character_name || '').trim()
        const targetName = (params.target_name || '').trim()
        const relationText = (params.relation || '').trim()
        const op = params.relationship_operation || 'add'

        if (!sourceName || !targetName) {
          throw new Error(text('维护人际关系必须同时提供 source_name 与 target_name', 'Both source_name and target_name are required'))
        }
        if (namesEqual(sourceName, targetName)) {
          throw new Error(text('不能为角色建立自相关系', 'A character cannot have a relationship with themselves'))
        }

        const snapshot = CharacterRosterRepository.read()
        const sourceEntry = findEntryByName(snapshot.entries, sourceName)
        if (!sourceEntry) {
          throw new Error(text(`源角色「${sourceName}」不存在`, `Source character "${sourceName}" does not exist`))
        }
        const targetEntry = findEntryByName(snapshot.entries, targetName)
        if (!targetEntry) {
          throw new Error(text(`目标角色「${targetName}」不存在`, `Target character "${targetName}" does not exist`))
        }

        let nextRelations = [...sourceEntry.relationships]
        if (op === 'remove') {
          nextRelations = nextRelations.filter((r) => !namesEqual(r.target, targetName))
        } else {
          if (!relationText) {
            throw new Error(text('添加或修改关系时必须提供 relation 参数描述具体关系', 'relation description is required for adding or updating relationship'))
          }
          const existingIdx = nextRelations.findIndex((r) => namesEqual(r.target, targetName))
          if (existingIdx >= 0) {
            nextRelations[existingIdx] = { target: targetEntry.name, relation: relationText }
          } else {
            nextRelations.push({ target: targetEntry.name, relation: relationText })
          }
        }

        const updatedEntries = snapshot.entries.map((e) => (
          namesEqual(e.name, sourceEntry.name) ? { ...e, relationships: nextRelations } : e
        ))

        commitRoster(snapshot, updatedEntries)
        await rendererAction({ type: 'refresh_character_roster' })

        const message = op === 'remove'
          ? text(`已移除角色「${sourceEntry.name}」与「${targetEntry.name}」之间的人际关系。`, `Relationship between "${sourceEntry.name}" and "${targetEntry.name}" removed.`)
          : text(`已更新「${sourceEntry.name}」与「${targetEntry.name}」的关系：${relationText}`, `Relationship between "${sourceEntry.name}" and "${targetEntry.name}" updated: ${relationText}`)

        return textResult(message, { source: sourceEntry.name, target: targetEntry.name, operation: op })
      }

      if (rawAction === 'batch_create' || rawAction === '批量创建') {
        const batchList = params.characters
        if (!Array.isArray(batchList) || batchList.length === 0) {
          throw new Error(text('batch_create 必须提供非空的 characters 角色列表', 'characters array is required for batch_create'))
        }

        const snapshot = CharacterRosterRepository.read()
        const existingNames = new Set(snapshot.entries.map((e) => e.name.toLowerCase()))
        const newEntries: CharacterRosterEntry[] = []
        const currentBatchNames = new Set<string>()

        for (const item of batchList) {
          const name = (item.name || '').trim()
          if (!name) throw new Error(text('批量创建中存在角色名为空的条目', 'Character name cannot be empty in batch_create'))
          const lower = name.toLowerCase()
          if (existingNames.has(lower) || currentBatchNames.has(lower)) {
            throw new Error(text(`角色名「${name}」重复或已存在`, `Character name "${name}" already exists or is duplicated in batch`))
          }
          currentBatchNames.add(lower)
          newEntries.push(normalizeEntryPayload(item))
        }

        const allAvailableNames = new Set([...existingNames, ...currentBatchNames])
        for (const entry of newEntries) {
          for (const rel of entry.relationships) {
            if (!allAvailableNames.has(rel.target.toLowerCase())) {
              throw new Error(text(`角色「${entry.name}」的关系目标「${rel.target}」既不存在于已有名单，也不在本次批量列表中`, `Relationship target "${rel.target}" not found`))
            }
          }
        }

        commitRoster(snapshot, [...snapshot.entries, ...newEntries])
        await rendererAction({ type: 'refresh_character_roster' })

        return textResult(
          text(
            `已成功批量创建 ${newEntries.length} 个角色：\n${newEntries.map(e => `- **${e.name}** [${formatRole(e.role, isEn)}]`).join('\n')}`,
            `Successfully created ${newEntries.length} characters in batch:\n${newEntries.map(e => `- **${e.name}** [${formatRole(e.role, isEn)}]`).join('\n')}`,
          ),
          { createdCount: newEntries.length, names: newEntries.map((e) => e.name) },
        )
      }

      if (rawAction === 'create' || rawAction === '创建' || rawAction === '新建') {
        const name = (params.name || params.character_name || '').trim()
        if (!name) {
          throw new Error(text('创建角色必须提供角色名 name', 'Character name is required for create'))
        }

        const snapshot = CharacterRosterRepository.read()
        if (findEntryByName(snapshot.entries, name)) {
          throw new Error(text(`角色「${name}」已存在，如需修改请使用 action: "update"`, `Character "${name}" already exists`))
        }

        const newEntry = normalizeEntryPayload({
          ...params,
          name,
        })

        for (const rel of newEntry.relationships) {
          if (!findEntryByName(snapshot.entries, rel.target)) {
            throw new Error(text(`关系目标角色「${rel.target}」不存在`, `Relationship target "${rel.target}" does not exist`))
          }
        }

        commitRoster(snapshot, [...snapshot.entries, newEntry])
        await rendererAction({ type: 'refresh_character_roster' })

        return textResult(
          text(
            `已成功创建角色「${newEntry.name}」[${formatRole(newEntry.role, isEn)}]。\n档案与初始状态已同步写入底层数据库并投影到故事架构。`,
            `Character "${newEntry.name}" created successfully.`,
          ),
          { name: newEntry.name, role: newEntry.role },
        )
      }

      if (rawAction === 'delete' || rawAction === '删除') {
        const charName = (params.character_name || params.name || '').trim()
        if (!charName) {
          throw new Error(text('删除角色必须指定 character_name', 'character_name is required for delete'))
        }

        const snapshot = CharacterRosterRepository.read()
        const targetEntry = findEntryByName(snapshot.entries, charName)
        if (!targetEntry) {
          throw new Error(text(`未找到角色「${charName}」，无法删除`, `Character "${charName}" not found`))
        }

        const updatedEntries = snapshot.entries
          .filter((e) => !namesEqual(e.name, charName))
          .map((e) => ({
            ...e,
            relationships: e.relationships.filter((r) => !namesEqual(r.target, charName)),
          }))

        commitRoster(snapshot, updatedEntries)
        await rendererAction({ type: 'refresh_character_roster' })

        return textResult(
          text(`角色「${targetEntry.name}」已成功删除，所有关联关系已自动清理。`, `Character "${targetEntry.name}" deleted successfully.`),
          { deletedName: targetEntry.name },
        )
      }

      if (rawAction === 'update' || rawAction === '修改' || rawAction === '更新') {
        const charName = (params.character_name || params.name || '').trim()
        if (!charName) {
          throw new Error(text('更新角色必须提供 character_name 指定目标角色', 'character_name is required for update'))
        }

        const snapshot = CharacterRosterRepository.read()
        const targetIdx = snapshot.entries.findIndex((e) => namesEqual(e.name, charName))
        if (targetIdx === -1) {
          throw new Error(text(`未找到角色「${charName}」`, `Character "${charName}" not found`))
        }

        const existing = snapshot.entries[targetIdx]
        const updated = { ...existing }

        if (params.role) updated.role = normalizeCharacterRole(params.role)
        if (params.gender !== undefined) updated.gender = String(params.gender).trim()
        if (params.age !== undefined) updated.age = String(params.age).trim()
        if (params.appearance !== undefined) updated.appearance = String(params.appearance).trim()
        if (params.personality !== undefined) updated.personality = String(params.personality).trim()
        if (params.background !== undefined) updated.background = String(params.background).trim()
        if (params.abilities !== undefined) updated.abilities = String(params.abilities).trim()
        if (params.motivation !== undefined) updated.motivation = String(params.motivation).trim()
        if (params.arc !== undefined) updated.arc = String(params.arc).trim()
        if (params.notes !== undefined) updated.notes = String(params.notes).trim()
        if (params.relationships !== undefined) {
          updated.relationships = params.relationships.map((r) => ({ target: r.target.trim(), relation: r.relation.trim() }))
        }

        const patch = params.state_patch || params.currentState
        if (patch) {
          const oldState: CharacterRosterCharacterState = existing.currentState ?? {
            location: '',
            powerLevel: '',
            physicalState: '',
            mentalState: '',
            keyItems: '',
            recentEvents: '',
            updatedAtChapter: 0,
          }
          let nextChapter = oldState.updatedAtChapter
          if (patch.updatedAtChapter !== undefined) {
            nextChapter = patch.updatedAtChapter
          } else if (params.chapter_number !== undefined) {
            nextChapter = params.chapter_number
          }
          const nextState: CharacterRosterCharacterState = { ...oldState, updatedAtChapter: nextChapter }
          for (const field of CHARACTER_STATE_TEXT_FIELDS) {
            if (patch[field] !== undefined) {
              nextState[field] = String(patch[field]).trim()
            }
          }
          updated.currentState = nextState
        }

        const nextEntries = [...snapshot.entries]
        nextEntries[targetIdx] = updated

        commitRoster(snapshot, nextEntries)
        await rendererAction({ type: 'refresh_character_roster' })

        return textResult(
          text(`角色「${existing.name}」已成功更新。`, `Character "${existing.name}" updated successfully.`),
          { name: existing.name },
        )
      }

      const snapshot = CharacterRosterRepository.read()
      let entries = snapshot.entries

      if (params.role) {
        const r = normalizeCharacterRole(params.role)
        entries = entries.filter((e) => e.role === r)
      }

      if (params.keyword) {
        const kw = params.keyword.trim().toLowerCase()
        entries = entries.filter((e) =>
          e.name.toLowerCase().includes(kw)
          || e.personality.toLowerCase().includes(kw)
          || e.background.toLowerCase().includes(kw)
          || e.abilities.toLowerCase().includes(kw)
          || e.motivation.toLowerCase().includes(kw)
          || e.notes.toLowerCase().includes(kw),
        )
      }

      const targetCharName = (params.character_name || params.name || '').trim()
      if (targetCharName) {
        const match = findEntryByName(entries, targetCharName)
          || entries.find((e) => e.name.toLowerCase().includes(targetCharName.toLowerCase()))
        if (!match) {
          throw new Error(text(
            `未找到匹配的角色「${targetCharName}」。当前可用角色：${snapshot.entries.map(e => e.name).join('、') || '暂无角色'}`,
            `Character "${targetCharName}" not found. Available characters: ${snapshot.entries.map(e => e.name).join(', ') || 'none'}`,
          ))
        }

        const histChapter = params.chapter_number
        let stateNote = ''
        if (histChapter !== undefined) {
          const histSnapshot = getChapterStateSnapshot(db, histChapter, match.name)
          if (histSnapshot) {
            stateNote = text(
              `\n\n### 第 ${histChapter} 章历史状态快照：\n${histSnapshot}`,
              `\n\n### Historical State at Ch. ${histChapter}:\n${histSnapshot}`,
            )
          } else if (match.currentState) {
            stateNote = text(
              `\n\n（注：未找到第 ${histChapter} 章专属快照，以下为该角色在第 ${match.currentState.updatedAtChapter} 章的记录状态）`,
              `\n\n(Note: No exclusive snapshot for Ch. ${histChapter}; showing state updated at Ch. ${match.currentState.updatedAtChapter})`,
            )
          }
        }

        return textResult(
          formatSingleCharacter(match, params.scope || 'all', isEn) + stateNote,
          { total: 1, name: match.name, role: match.role },
        )
      }

      const limit = params.limit || 50
      const visible = entries.slice(0, limit)

      if (visible.length === 0) {
        return textResult(
          text('当前项目中暂无符合条件的角色。', 'No characters found in current project.'),
          { total: 0 },
        )
      }

      const listLines: string[] = [
        text(`### 角色名单（共 ${entries.length} 位角色，展示前 ${visible.length} 位）：\n`, `### Character Roster (${entries.length} characters, showing top ${visible.length}):\n`),
      ]

      for (const entry of visible) {
        let line = `- **${entry.name}** [${formatRole(entry.role, isEn)}]`
        if (entry.gender || entry.age) line += ` (${[entry.gender, entry.age].filter(Boolean).join(', ')})`
        if (entry.background) {
          const preview = entry.background.length > 40
            ? `${entry.background.slice(0, 40)}...`
            : entry.background
          line += ` · 背景: ${preview}`
        }
        if (entry.currentState) {
          line += `\n  - 状态 (第 ${entry.currentState.updatedAtChapter} 章): 位置 [${entry.currentState.location || '未知'}] | 境界 [${entry.currentState.powerLevel || '常规'}] | 身心 [${entry.currentState.physicalState || '良好'}]`
        }
        listLines.push(line)
      }

      return textResult(listLines.join('\n'), { total: entries.length, returned: visible.length })
    },
  }
}

function namesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function findEntryByName(
  entries: CharacterRosterEntry[],
  name: string,
): CharacterRosterEntry | undefined {
  return entries.find((entry) => namesEqual(entry.name, name))
}

function textResult(
  body: string,
  details: Record<string, unknown>,
): { content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> } {
  return {
    content: [{ type: 'text', text: body }],
    details,
  }
}

function commitRoster(
  snapshot: CharacterRosterSnapshot,
  entries: CharacterRosterEntry[],
  renames?: CharacterRosterRename[],
): void {
  CharacterRosterRepository.commit({
    operationId: randomUUID(),
    expectedRevision: snapshot.revision,
    schemaVersion: CHARACTER_ROSTER_SCHEMA_VERSION,
    intent: 'manual_edit',
    entries,
    ...(renames ? { renames } : {}),
  })
}

function normalizeEntryPayload(payload: Record<string, unknown>): CharacterRosterEntry {
  const name = String(payload.name || '').trim()
  const role: CharacterRole = normalizeCharacterRole(String(payload.role || 'supporting'))

  const rawRels = Array.isArray(payload.relationships) ? payload.relationships : []
  const relationships: CharacterRosterRelationship[] = rawRels.map((r) => {
    const rel = r as Record<string, unknown>
    return {
      target: String(rel.target || '').trim(),
      relation: String(rel.relation || '').trim(),
    }
  }).filter((r) => Boolean(r.target))

  let currentState: CharacterRosterCharacterState | undefined
  if (payload.currentState && typeof payload.currentState === 'object') {
    const cs = payload.currentState as Record<string, unknown>
    currentState = {
      location: '',
      powerLevel: '',
      physicalState: '',
      mentalState: '',
      keyItems: '',
      recentEvents: '',
      updatedAtChapter: Number.isSafeInteger(cs.updatedAtChapter) ? Number(cs.updatedAtChapter) : 0,
    }
    for (const field of CHARACTER_STATE_TEXT_FIELDS) {
      currentState[field] = String(cs[field] || '').trim()
    }
  }

  return {
    name,
    role,
    gender: String(payload.gender || '').trim(),
    age: String(payload.age || '').trim(),
    appearance: String(payload.appearance || '').trim(),
    personality: String(payload.personality || '').trim(),
    background: String(payload.background || '').trim(),
    abilities: String(payload.abilities || '').trim(),
    motivation: String(payload.motivation || '').trim(),
    arc: String(payload.arc || '').trim(),
    notes: String(payload.notes || '').trim(),
    relationships,
    ...(currentState ? { currentState } : {}),
  }
}

function formatRole(role: string, isEn: boolean): string {
  switch (role) {
    case 'protagonist': return isEn ? 'Protagonist' : '主角'
    case 'antagonist': return isEn ? 'Antagonist' : '反派'
    case 'supporting': return isEn ? 'Supporting' : '重要配角'
    case 'minor': return isEn ? 'Minor' : '龙套配角'
    default: return isEn ? 'Supporting' : '配角'
  }
}

function pushLabeled(
  lines: string[],
  value: string | undefined,
  zh: string,
  en: string,
  isEn: boolean,
  prefix = '- ',
): void {
  if (!value) return
  lines.push(`${prefix}${isEn ? en : zh}: ${value}`)
}

function formatSingleCharacter(entry: CharacterRosterEntry, scope: string, isEn: boolean): string {
  const lines: string[] = [`# ${entry.name} [${formatRole(entry.role, isEn)}]`]

  if (scope === 'all' || scope === 'profile') {
    pushLabeled(lines, entry.gender, '性别', 'Gender', isEn)
    pushLabeled(lines, entry.age, '年龄', 'Age', isEn)
    pushLabeled(lines, entry.appearance, '外貌', 'Appearance', isEn)
    pushLabeled(lines, entry.personality, '性格', 'Personality', isEn)
    pushLabeled(lines, entry.background, '背景', 'Background', isEn)
    pushLabeled(lines, entry.abilities, '能力/功法', 'Abilities', isEn)
    pushLabeled(lines, entry.motivation, '核心动机', 'Motivation', isEn)
    pushLabeled(lines, entry.arc, '人物弧光', 'Arc', isEn)
    pushLabeled(lines, entry.notes, '备忘录', 'Notes', isEn)

    if (entry.relationships && entry.relationships.length > 0) {
      lines.push(isEn ? '### Relationships:' : '### 人际关系网络:')
      for (const rel of entry.relationships) {
        lines.push(`  - **${rel.target}**: ${rel.relation}`)
      }
    }
  }

  if ((scope === 'all' || scope === 'state') && entry.currentState) {
    const state = entry.currentState
    lines.push(
      isEn
        ? `### Current State (Ch. ${state.updatedAtChapter}):`
        : `### 当前动态状态（第 ${state.updatedAtChapter} 章）:`,
    )
    pushLabeled(lines, state.location, '当前位置', 'Location', isEn, '  - ')
    pushLabeled(lines, state.powerLevel, '实力境界', 'Power level', isEn, '  - ')
    pushLabeled(lines, state.physicalState, '生理状态', 'Physical state', isEn, '  - ')
    pushLabeled(lines, state.mentalState, '心理状态', 'Mental state', isEn, '  - ')
    pushLabeled(lines, state.keyItems, '持有道具', 'Key items', isEn, '  - ')
    pushLabeled(lines, state.recentEvents, '近期经历', 'Recent events', isEn, '  - ')
  }

  return lines.join('\n')
}

function getChapterStateSnapshot(
  db: ReturnType<typeof getProjectDb>,
  chapterNumber: number,
  charName: string,
): string | null {
  if (!db) return null
  try {
    const row = db.prepare(`
      SELECT character_states, chapter_number
      FROM summary_snapshots
      WHERE chapter_number <= ? AND character_states IS NOT NULL AND character_states != ''
      ORDER BY chapter_number DESC, id DESC
      LIMIT 1
    `).get(chapterNumber) as { character_states: string; chapter_number: number } | undefined

    if (!row?.character_states?.includes(charName)) return null
    return `第 ${row.chapter_number} 章快照片段：\n${row.character_states}`
  } catch {
    return null
  }
}
