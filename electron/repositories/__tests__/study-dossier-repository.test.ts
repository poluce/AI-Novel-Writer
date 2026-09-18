import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, initProjectDatabase } from '../../database'
import { ProjectCoreRepository } from '../project-core-repository'
import { CharacterRosterRepository } from '../character-roster-repository'
import { BlueprintRepository } from '../blueprint-repository'
import { StudyDossierRepository } from '../study-dossier-repository'
import type { NovelStudyDossier } from '../../../src/shared/novel-study'

let root = ''

function sampleDossier(overrides: Partial<NovelStudyDossier> = {}): NovelStudyDossier {
  return {
    id: 'study-1',
    runId: 'run-1',
    title: '参考佳作：测试名著',
    sourceFiles: [{ name: 'sample.txt', size: 1024 }],
    totalChapters: 3,
    totalWords: 9000,
    createdAt: '2026-09-20T10:00:00Z',
    updatedAt: '2026-09-20T10:00:00Z',
    styleProfile: {
      pacingAndStructure: '快节奏，多幕次转场',
      syntaxAndScene: '短句为主，动作推进',
      dialogueAndEmotion: '冷峻克制，潜台词丰富',
      actionableTechniques: ['前三句抛出钩子', '对白保持潜台词'],
      cautions: ['避免冗长环境描写'],
      rawAnalysis: '文风档案：快节奏，动作推进。仿写指南：前三句抛出钩子。',
    },
    inferredOutline: {
      genre: '悬疑',
      subGenre: '惊悚',
      targetAudience: '青年',
      plotStructure: 'three_act',
      narrativePov: 'third_limited',
      coreOutline: '主角追踪失踪案件，揭开惊天阴谋',
      worldSetting: '架空现代海滨孤城',
      goldenFinger: '敏锐的微表情观察力',
      protagonistProfile: '沉默寡言的退役刑警',
      globalGuidance: '每一章末尾必须留悬念',
      premise: '当正义无法伸张，真相将以何种代价显现',
      worldbuilding: '被迷雾封闭的边境城市',
      synopsis: '一部讲述救赎与复仇的硬汉派悬疑小说',
    },
    characterCards: [
      {
        name: '林巡',
        role: 'protagonist',
        personality: '沉稳冷静',
        appearance: '风衣，面容削瘦',
        background: '前刑警队长',
        motivation: '查明搭档殉职真相',
        abilities: '格斗与微表情分析',
      },
      {
        name: '苏然',
        role: 'supporting',
        personality: '机智敏锐',
        appearance: '常戴金丝眼镜',
        background: '法医顾问',
        motivation: '协助调查',
        abilities: '痕迹勘验',
      },
    ],
    blueprints: [
      {
        chapterNumber: 1,
        title: '迷雾雨夜',
        role: '建置',
        purpose: '建立世界观与抛出首个死者',
        characters: ['林巡'],
        keyEvents: '林巡在雨夜接到神秘求助电话，赶到现场发现搭档遗物',
        suspenseHook: '死者手中握着的怀表刻着林巡的名字',
      },
      {
        chapterNumber: 2,
        title: '法医的警告',
        role: '发展',
        purpose: '引入第二主角并发现线索异常',
        characters: ['林巡', '苏然'],
        keyEvents: '苏然指出伤口不属于人类武器，警局高层要求立刻结案',
        suspenseHook: '档案室突发大火，关键证物被毁',
      },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-study-dossier-'))
  initProjectDatabase(root)
  ProjectCoreRepository.init('研习测试项目')
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('StudyDossierRepository', () => {
  it('saves and retrieves a novel study dossier cleanly', () => {
    const dossier = sampleDossier()
    StudyDossierRepository.save(dossier)

    const fetched = StudyDossierRepository.get('study-1')
    expect(fetched).not.toBeNull()
    expect(fetched?.title).toBe('参考佳作：测试名著')
    expect(fetched?.totalChapters).toBe(3)
    expect(fetched?.styleProfile.pacingAndStructure).toBe('快节奏，多幕次转场')
    expect(fetched?.characterCards).toHaveLength(2)
    expect(fetched?.blueprints).toHaveLength(2)

    const fetchedByRun = StudyDossierRepository.getByRunId('run-1')
    expect(fetchedByRun?.id).toBe('study-1')
  })

  it('lists dossiers and supports deletion', () => {
    StudyDossierRepository.save(sampleDossier({ id: 'study-1', runId: 'run-1' }))
    StudyDossierRepository.save(sampleDossier({ id: 'study-2', runId: 'run-2', title: '第二部参考书' }))

    const all = StudyDossierRepository.list()
    expect(all).toHaveLength(2)

    const deleted = StudyDossierRepository.delete('study-1')
    expect(deleted).toBe(true)
    expect(StudyDossierRepository.get('study-1')).toBeNull()
    expect(StudyDossierRepository.list()).toHaveLength(1)
  })

  it('applies selective projection to project core, characters, and blueprints', () => {
    const dossier = sampleDossier()
    StudyDossierRepository.save(dossier)

    // Apply only style and characters, keeping original outline
    const receipt = StudyDossierRepository.applyProjection({
      dossierId: 'study-1',
      applyStyle: true,
      applyOutline: false,
      selectedCharacterNames: ['林巡'],
      selectedBlueprintRange: { startChapter: 1, endChapter: 1 },
    })

    expect(receipt.appliedStyle).toBe(true)
    expect(receipt.appliedOutline).toBe(false)
    expect(receipt.appliedCharactersCount).toBe(1)
    expect(receipt.appliedBlueprintsCount).toBe(1)

    // Check project core
    const core = ProjectCoreRepository.get()
    expect(core?.writingStyle).toBe('文风档案：快节奏，动作推进。仿写指南：前三句抛出钩子。')
    // Outline was NOT applied, so original project values remain
    expect(core?.genre).not.toBe('悬疑')

    // Check characters
    const roster = CharacterRosterRepository.read()
    expect(roster.entries.map(e => e.name)).toContain('林巡')
    expect(roster.entries.map(e => e.name)).not.toContain('苏然')

    // Check blueprints
    const blueprint1 = BlueprintRepository.getByChapter(1)
    expect(blueprint1?.title).toBe('迷雾雨夜')
    const blueprint2 = BlueprintRepository.getByChapter(2)
    expect(blueprint2).toBeNull()
  })

  it('applies full outline projection when requested', () => {
    const dossier = sampleDossier()
    StudyDossierRepository.save(dossier)

    const receipt = StudyDossierRepository.applyProjection({
      dossierId: 'study-1',
      applyStyle: true,
      applyOutline: true,
    })

    expect(receipt.appliedOutline).toBe(true)
    const core = ProjectCoreRepository.get()
    expect(core?.genre).toBe('悬疑')
    expect(core?.subGenre).toBe('惊悚')
    expect(core?.coreOutline).toBe('主角追踪失踪案件，揭开惊天阴谋')
    expect(core?.worldSetting).toBe('架空现代海滨孤城')
  })
})
