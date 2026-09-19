import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createManageCharactersTool } from '../manage-characters.tool'
import { CharacterRosterRepository } from '../../../repositories/character-roster-repository'
import { BlueprintRepository } from '../../../repositories/blueprint-repository'
import * as databaseModule from '../../../database'
import type { CharacterRosterEntry } from '../../../../src/shared/character-roster'

vi.mock('../../../repositories/character-roster-repository', () => ({
  CharacterRosterRepository: {
    read: vi.fn(),
    commit: vi.fn(),
  },
}))

vi.mock('../../../repositories/blueprint-repository', () => ({
  BlueprintRepository: {
    getAll: vi.fn(),
    getByChapter: vi.fn(),
  },
}))

vi.mock('../../../database', () => ({
  getCurrentProjectPath: vi.fn(),
  getProjectDb: vi.fn(),
}))

function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
  const first = res.content[0]
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('expected text content')
  }
  return first.text
}

describe('manage_characters tool', () => {
  let mockEntries: CharacterRosterEntry[]
  let mockSnapshot: { revision: number; status: string; entries: CharacterRosterEntry[] }
  let mockDb: { prepare: ReturnType<typeof vi.fn> }
  let mockBlueprints: Array<{ chapterNumber: number; title: string; characters: string[] }>
  let emittedActions: unknown[]

  const rendererAction = (action: unknown) => {
    emittedActions.push(action)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    emittedActions = []

    mockEntries = [
      {
        name: '陆舟',
        role: 'protagonist',
        gender: '男',
        age: '20',
        appearance: '身姿挺拔，一袭素白儒衫',
        personality: '沉稳内敛，心志坚毅',
        background: '前九峰真传，因变故被贬至外门',
        abilities: '虚灵剑诀，识微通幽',
        motivation: '查明师尊失踪真相，重登道巅',
        arc: '从避世自保到肩挑苍生宿命',
        notes: '身怀神秘残损铜戒',
        relationships: [
          { target: '苏绾', relation: '同门师妹，生死托付' },
          { target: '顾岩', relation: '执法堂主，势同水火' },
        ],
        currentState: {
          location: '外门灵药圃',
          powerLevel: '炼气期九层',
          physicalState: '健康，经脉稍涩',
          mentalState: '冷静笃定',
          keyItems: '锈迹铁剑、半块残缺古玉',
          recentEvents: '在药园击退外门挑衅弟子',
          updatedAtChapter: 1,
        },
      },
      {
        name: '苏绾',
        role: 'supporting',
        gender: '女',
        age: '18',
        appearance: '青衣如荷，明眸若水',
        personality: '聪慧敏锐，外柔内刚',
        background: '天枢峰长者之女',
        abilities: '回春灵术，幻音弄尘',
        motivation: '护得陆舟周全，摆脱家族联姻枷锁',
        arc: '突破依附，独当一面',
        notes: '暗中替陆舟打探内门风声',
        relationships: [
          { target: '陆舟', relation: '并肩知己，暗生情愫' },
        ],
        currentState: {
          location: '天枢峰居所',
          powerLevel: '炼气期八层',
          physicalState: '健康',
          mentalState: '忧心忡忡',
          keyItems: '凝神香炉',
          recentEvents: '婉拒了顾氏提亲',
          updatedAtChapter: 2,
        },
      },
      {
        name: '顾岩',
        role: 'antagonist',
        gender: '男',
        age: '45',
        appearance: '鹰视狼顾，面容冷厉',
        personality: '狠辣专横，城府极深',
        background: '宗门执法堂首席长老',
        abilities: '幽冥血爪，化血神功',
        motivation: '斩草除根，侵夺前峰主道藏',
        arc: '欲望噬心，终至道消身死',
        notes: '怀疑当年秘境惨案与他有直接关系',
        relationships: [
          { target: '陆舟', relation: '欲除之而后快的眼中钉' },
        ],
        currentState: {
          location: '执法堂后殿',
          powerLevel: '筑基后期',
          physicalState: '气血旺盛',
          mentalState: '阴鸷自负',
          keyItems: '执法金令',
          recentEvents: '暗中派遣死士盯防药园',
          updatedAtChapter: 1,
        },
      },
    ]

    mockSnapshot = {
      revision: 3,
      status: 'ready',
      entries: mockEntries,
    }

    mockBlueprints = [
      { chapterNumber: 1, title: '初醒药庐', characters: ['陆舟', '顾岩'] },
      { chapterNumber: 2, title: '同门暗顾', characters: ['陆舟', '苏绾'] },
      { chapterNumber: 5, title: '黑市风云', characters: ['陆舟'] },
    ]

    mockDb = {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn(),
        all: vi.fn(),
        run: vi.fn(),
      }),
    }

    vi.mocked(databaseModule.getCurrentProjectPath).mockReturnValue('/workspace/novel')
    vi.mocked(databaseModule.getProjectDb).mockReturnValue(mockDb as never)
    vi.mocked(CharacterRosterRepository.read).mockReturnValue(mockSnapshot as never)
    vi.mocked(BlueprintRepository.getAll).mockReturnValue(mockBlueprints as never)
    vi.mocked(BlueprintRepository.getByChapter).mockImplementation((num: number) => {
      return mockBlueprints.find(b => b.chapterNumber === num) as never
    })
  })

  // =========================================================================
  // 1. 读取 (read)
  // =========================================================================
  describe('read operation', () => {
    it('lists all characters with summaries by default', async () => {
      const tool = createManageCharactersTool('zh-CN', rendererAction)
      const res = await tool.execute('c1', { action: 'read' })

      expect(res.details.total).toBe(3)
      const text = textOf(res)
      expect(text).toContain('陆舟')
      expect(text).toContain('苏绾')
      expect(text).toContain('顾岩')
      expect(text).toContain('主角')
      expect(text).toContain('反派')
    })

    it('filters characters by role', async () => {
      const tool = createManageCharactersTool('zh-CN', rendererAction)
      const res = await tool.execute('c2', { action: 'read', role: 'antagonist' })

      expect(res.details.total).toBe(1)
      const text = textOf(res)
      expect(text).toContain('顾岩')
      expect(text).not.toContain('陆舟')
    })

    it('filters characters by keyword across background/abilities', async () => {
      const tool = createManageCharactersTool('zh-CN', rendererAction)
      const res = await tool.execute('c3', { action: 'read', keyword: '执法堂' })

      expect(res.details.total).toBe(1)
      const text = textOf(res)
      expect(text).toContain('顾岩')
    })

    it('reads single character with full profile and relationships', async () => {
      const tool = createManageCharactersTool('zh-CN', rendererAction)
      const res = await tool.execute('c4', { action: 'read', character_name: '陆舟' })

      expect(res.details.name).toBe('陆舟')
      const text = textOf(res)
      expect(text).toContain('虚灵剑诀')
      expect(text).toContain('外门灵药圃')
      expect(text).toContain('苏绾')
    })

    it('reads single character with scoped profile or state', async () => {
      const tool = createManageCharactersTool('zh-CN', rendererAction)
      const resProfile = await tool.execute('c5', { action: 'read', character_name: '陆舟', scope: 'profile' })
      expect(textOf(resProfile)).toContain('虚灵剑诀')
      expect(textOf(resProfile)).not.toContain('外门灵药圃')

      const resState = await tool.execute('c6', { action: 'read', character_name: '陆舟', scope: 'state' })
      expect(textOf(resState)).toContain('外门灵药圃')
      expect(textOf(resState)).not.toContain('虚灵剑诀')
    })

    it('retrieves chapter historical snapshot when chapter_number is provided', async () => {
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({
          chapter_number: 1,
          character_states: '陆舟在第一章结束时受了轻伤，缴获半块古玉。',
        }),
      } as never)

      const tool = createManageCharactersTool('zh-CN', rendererAction)
      const res = await tool.execute('c7', { action: 'read', character_name: '陆舟', chapter_number: 1 })

      expect(textOf(res)).toContain('第 1 章历史状态快照')
      expect(textOf(res)).toContain('半块古玉')
    })

    it('throws when character not found', async () => {
      const tool = createManageCharactersTool('zh-CN', rendererAction)
      await expect(tool.execute('c8', { action: 'read', character_name: '不存在之人' }))
        .rejects.toThrow('未找到匹配的角色「不存在之人」')
    })
  })

  // =========================================================================
  // 2. 出场追踪 (track_appearances)
  // =========================================================================
  describe('track_appearances operation', () => {
    it('tracks all appearances of a character across chapter blueprints', async () => {
      const tool = createManageCharactersTool('zh-CN', rendererAction)
      const res = await tool.execute('c9', { action: 'track_appearances', character_name: '陆舟' })

      expect(res.details.totalAppearances).toBe(3)
      expect(res.details.chapters).toEqual([1, 2, 5])
      expect(textOf(res)).toContain('第 1 章、第 2 章、第 5 章')
    })

    it('reverses query: retrieves all characters scheduled in a chapter blueprint', async () => {
      const tool = createManageCharactersTool('zh-CN', rendererAction)
      const res = await tool.execute('c10', { action: 'track_appearances', chapter_number: 2 })

      expect(res.details.characterNames).toEqual(['陆舟', '苏绾'])
      const text = textOf(res)
      expect(text).toContain('第 2 章出场角色阵容')
      expect(text).toContain('陆舟')
      expect(text).toContain('苏绾')
    })

    it('warns when character has no appearances in blueprints', async () => {
      const tool = createManageCharactersTool('zh-CN', rendererAction)
      const res = await tool.execute('c11', { action: 'track_appearances', character_name: '未登场角色' })

      expect(res.details.totalAppearances).toBe(0)
      expect(textOf(res)).toContain('尚未有出场记录')
    })

    it('throws when neither character_name nor chapter_number is provided', async () => {
      const tool = createManageCharactersTool('zh-CN', rendererAction)
      await expect(tool.execute('c12', { action: 'track_appearances' }))
        .rejects.toThrow('必须提供 character_name')
    })
  })

  // =========================================================================
  // 3. 创建 (create & batch_create)
  // =========================================================================
  describe('create and batch_create operations', () => {
    it('creates a single character and commits to repository', async () => {
      const tool = createManageCharactersTool('zh-CN', rendererAction)
      const res = await tool.execute('c13', {
        action: 'create',
        name: '白浅浅',
        role: 'supporting',
        gender: '女',
        age: '16',
        abilities: '御兽通灵',
        relationships: [{ target: '陆舟', relation: '被解救的灵狐族少女' }],
        currentState: {
          location: '落日森林',
          powerLevel: '炼气四层',
          updatedAtChapter: 3,
        },
      })

      expect(res.details.name).toBe('白浅浅')
      expect(CharacterRosterRepository.commit).toHaveBeenCalledTimes(1)
      const commitArg = vi.mocked(CharacterRosterRepository.commit).mock.calls[0][0]
      expect(commitArg.intent).toBe('manual_edit')
      expect(commitArg.entries.some(e => e.name === '白浅浅')).toBe(true)
      expect(emittedActions).toEqual([{ type: 'refresh_character_roster' }])
    })

    it('rejects create if character name already exists', async () => {
      const tool = createManageCharactersTool('zh-CN', rendererAction)
      await expect(tool.execute('c14', { action: 'create', name: '陆舟' }))
        .rejects.toThrow('角色「陆舟」已存在')
    })

    it('rejects create if relationship target does not exist', async () => {
      const tool = createManageCharactersTool('zh-CN', rendererAction)
      await expect(tool.execute('c15', {
        action: 'create',
        name: '新角色',
        relationships: [{ target: '虚无之人', relation: '仇人' }],
      })).rejects.toThrow('关系目标角色「虚无之人」不存在')
    })

    it('batch creates an entire faction/sect with intra-batch relationships', async () => {
      const tool = createManageCharactersTool('zh-CN', rendererAction)
      const res = await tool.execute('c16', {
        action: 'batch_create',
        characters: [
          {
            name: '万剑一',
            role: 'supporting',
            background: '万剑宗掌门',
            relationships: [{ target: '萧晨', relation: '大弟子' }],
          },
          {
            name: '萧晨',
            role: 'supporting',
            background: '万剑宗首席大弟子',
            relationships: [{ target: '万剑一', relation: '恩师' }],
          },
        ],
      })

      expect(res.details.createdCount).toBe(2)
      expect(CharacterRosterRepository.commit).toHaveBeenCalledTimes(1)
      const commitArg = vi.mocked(CharacterRosterRepository.commit).mock.calls[0][0]
      expect(commitArg.entries.length).toBe(5) // 3 existing + 2 new
      expect(emittedActions).toEqual([{ type: 'refresh_character_roster' }])
    })

    it('rejects batch_create with duplicated names inside batch', async () => {
      const tool = createManageCharactersTool('zh-CN', rendererAction)
      await expect(tool.execute('c17', {
        action: 'batch_create',
        characters: [
          { name: '重复人' },
          { name: '重复人' },
        ],
      })).rejects.toThrow('角色名「重复人」重复或已存在')
    })
  })

  // =========================================================================
  // 4. 更新与增量继承 (update)
  // =========================================================================
  describe('update operation', () => {
    it('partially updates profile fields', async () => {
      const tool = createManageCharactersTool('zh-CN', rendererAction)
      const res = await tool.execute('c18', {
        action: 'update',
        character_name: '陆舟',
        motivation: '新的核心欲望：守护青云宗',
      })

      expect(res.details.name).toBe('陆舟')
      const commitArg = vi.mocked(CharacterRosterRepository.commit).mock.calls[0][0]
      const updated = commitArg.entries.find(e => e.name === '陆舟')!
      expect(updated.motivation).toBe('新的核心欲望：守护青云宗')
      expect(updated.abilities).toBe('虚灵剑诀，识微通幽') // 未传字段保留
    })

    it('delta updates currentState with field inheritance', async () => {
      const tool = createManageCharactersTool('zh-CN', rendererAction)
      await tool.execute('c19', {
        action: 'update',
        character_name: '陆舟',
        chapter_number: 10,
        state_patch: {
          location: '黑雾森林深处',
          physicalState: '左臂受暗器划伤',
        },
      })

      const commitArg = vi.mocked(CharacterRosterRepository.commit).mock.calls[0][0]
      const updated = commitArg.entries.find(e => e.name === '陆舟')!
      expect(updated.currentState?.location).toBe('黑雾森林深处')
      expect(updated.currentState?.physicalState).toBe('左臂受暗器划伤')
      // 未提及的旧状态字段必须完整继承！
      expect(updated.currentState?.powerLevel).toBe('炼气期九层')
      expect(updated.currentState?.keyItems).toBe('锈迹铁剑、半块残缺古玉')
      expect(updated.currentState?.updatedAtChapter).toBe(10)
    })

    it('throws when updating non-existent character', async () => {
      const tool = createManageCharactersTool('zh-CN', rendererAction)
      await expect(tool.execute('c20', { action: 'update', character_name: '查无此人' }))
        .rejects.toThrow('未找到角色「查无此人」')
    })
  })

  // =========================================================================
  // 5. 级联改名 (rename)
  // =========================================================================
  describe('rename operation', () => {
    it('renames character and cascades to relationships across the whole roster', async () => {
      const tool = createManageCharactersTool('zh-CN', rendererAction)
      const res = await tool.execute('c21', {
        action: 'rename',
        original_name: '陆舟',
        new_name: '陆问天',
      })

      expect(res.details.originalName).toBe('陆舟')
      expect(res.details.newName).toBe('陆问天')
      const commitArg = vi.mocked(CharacterRosterRepository.commit).mock.calls[0][0]
      expect(commitArg.renames).toEqual([{ originalName: '陆舟', newName: '陆问天' }])

      // 验证其他角色指向陆舟的关系目标被自动改为了陆问天
      const su = commitArg.entries.find(e => e.name === '苏绾')!
      expect(su.relationships[0]?.target).toBe('陆问天')

      const gu = commitArg.entries.find(e => e.name === '顾岩')!
      expect(gu.relationships[0]?.target).toBe('陆问天')

      expect(emittedActions).toContainEqual({ type: 'refresh_character_roster' })
      expect(emittedActions).toContainEqual({ type: 'refresh_blueprint' })
    })

    it('rejects rename if new name conflicts with existing character', async () => {
      const tool = createManageCharactersTool('zh-CN', rendererAction)
      await expect(tool.execute('c22', {
        action: 'rename',
        original_name: '陆舟',
        new_name: '苏绾',
      })).rejects.toThrow('新角色名「苏绾」已被占用')
    })
  })

  // =========================================================================
  // 6. 人际关系定向维护 (update_relationship)
  // =========================================================================
  describe('update_relationship operation', () => {
    it('adds or updates a relationship between two characters', async () => {
      const tool = createManageCharactersTool('zh-CN', rendererAction)
      await tool.execute('c23', {
        action: 'update_relationship',
        source_name: '苏绾',
        target_name: '顾岩',
        relation: '宗门死敌，誓为师兄报仇',
      })

      const commitArg = vi.mocked(CharacterRosterRepository.commit).mock.calls[0][0]
      const su = commitArg.entries.find(e => e.name === '苏绾')!
      const rel = su.relationships.find(r => r.target === '顾岩')
      expect(rel?.relation).toBe('宗门死敌，誓为师兄报仇')
    })

    it('removes a relationship between two characters', async () => {
      const tool = createManageCharactersTool('zh-CN', rendererAction)
      await tool.execute('c24', {
        action: 'update_relationship',
        source_name: '陆舟',
        target_name: '顾岩',
        relationship_operation: 'remove',
      })

      const commitArg = vi.mocked(CharacterRosterRepository.commit).mock.calls[0][0]
      const lu = commitArg.entries.find(e => e.name === '陆舟')!
      expect(lu.relationships.some(r => r.target === '顾岩')).toBe(false)
      expect(lu.relationships.some(r => r.target === '苏绾')).toBe(true)
    })

    it('rejects self-referential relationship', async () => {
      const tool = createManageCharactersTool('zh-CN', rendererAction)
      await expect(tool.execute('c25', {
        action: 'update_relationship',
        source_name: '陆舟',
        target_name: '陆舟',
        relation: '自己与自己',
      })).rejects.toThrow('不能为角色建立自相关系')
    })
  })

  // =========================================================================
  // 7. 删除 (delete)
  // =========================================================================
  describe('delete operation', () => {
    it('deletes character and cleans up references in other characters', async () => {
      const tool = createManageCharactersTool('zh-CN', rendererAction)
      const res = await tool.execute('c26', { action: 'delete', character_name: '顾岩' })

      expect(res.details.deletedName).toBe('顾岩')
      const commitArg = vi.mocked(CharacterRosterRepository.commit).mock.calls[0][0]
      expect(commitArg.entries.some(e => e.name === '顾岩')).toBe(false)

      // 陆舟指向顾岩的关系自动清理
      const lu = commitArg.entries.find(e => e.name === '陆舟')!
      expect(lu.relationships.some(r => r.target === '顾岩')).toBe(false)
      expect(lu.relationships.some(r => r.target === '苏绾')).toBe(true)
    })

    it('throws when deleting non-existent character', async () => {
      const tool = createManageCharactersTool('zh-CN', rendererAction)
      await expect(tool.execute('c27', { action: 'delete', character_name: '不存在之人' }))
        .rejects.toThrow('未找到角色「不存在之人」')
    })
  })
})
