import { getProjectDb } from '../database'
import type {
  NovelStudyDossier,
  NovelStudyProjectionOptions,
  NovelStudyProjectionReceipt,
} from '../../src/shared/novel-study'
import { ProjectCoreRepository } from './project-core-repository'
import { CharacterRosterRepository } from './character-roster-repository'
import { BlueprintRepository } from './blueprint-repository'
import type { BlueprintRangeCommitRequest } from '../../src/shared/contracts/blueprint-commit'

interface StudyDossierRow {
  id: string
  run_id: string
  title: string
  source_files_json: string
  total_chapters: number
  total_words: number
  style_profile_json: string
  inferred_outline_json: string
  character_cards_json: string
  blueprints_json: string
  knowledge_partition_id: string | null
  created_at: string
  updated_at: string
}

function rowToDossier(row: StudyDossierRow): NovelStudyDossier {
  return {
    id: row.id,
    runId: row.run_id,
    title: row.title,
    sourceFiles: JSON.parse(row.source_files_json),
    totalChapters: row.total_chapters,
    totalWords: row.total_words,
    styleProfile: JSON.parse(row.style_profile_json),
    inferredOutline: JSON.parse(row.inferred_outline_json),
    characterCards: JSON.parse(row.character_cards_json),
    blueprints: JSON.parse(row.blueprints_json),
    knowledgePartitionId: row.knowledge_partition_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function ensureStudyDossierSchema(db: ReturnType<typeof getProjectDb>): void {
  if (!db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS study_dossiers (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      title TEXT NOT NULL,
      source_files_json TEXT NOT NULL,
      total_chapters INTEGER NOT NULL,
      total_words INTEGER NOT NULL,
      style_profile_json TEXT NOT NULL,
      inferred_outline_json TEXT NOT NULL,
      character_cards_json TEXT NOT NULL,
      blueprints_json TEXT NOT NULL,
      knowledge_partition_id TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_study_dossiers_run_id ON study_dossiers(run_id);
  `)
}

export class StudyDossierRepository {
  static save(dossier: NovelStudyDossier): void {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    ensureStudyDossierSchema(db)
    db.prepare(`
      INSERT INTO study_dossiers (
        id, run_id, title, source_files_json, total_chapters, total_words,
        style_profile_json, inferred_outline_json, character_cards_json,
        blueprints_json, knowledge_partition_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        source_files_json = excluded.source_files_json,
        total_chapters = excluded.total_chapters,
        total_words = excluded.total_words,
        style_profile_json = excluded.style_profile_json,
        inferred_outline_json = excluded.inferred_outline_json,
        character_cards_json = excluded.character_cards_json,
        blueprints_json = excluded.blueprints_json,
        knowledge_partition_id = excluded.knowledge_partition_id,
        updated_at = excluded.updated_at
    `).run(
      dossier.id,
      dossier.runId,
      dossier.title,
      JSON.stringify(dossier.sourceFiles),
      dossier.totalChapters,
      dossier.totalWords,
      JSON.stringify(dossier.styleProfile),
      JSON.stringify(dossier.inferredOutline),
      JSON.stringify(dossier.characterCards),
      JSON.stringify(dossier.blueprints),
      dossier.knowledgePartitionId ?? null,
      dossier.createdAt || new Date().toISOString(),
      dossier.updatedAt || new Date().toISOString(),
    )
  }

  static get(id: string): NovelStudyDossier | null {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    ensureStudyDossierSchema(db)
    const row = db.prepare('SELECT * FROM study_dossiers WHERE id = ?').get(id) as StudyDossierRow | undefined
    return row ? rowToDossier(row) : null
  }

  static getByRunId(runId: string): NovelStudyDossier | null {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    ensureStudyDossierSchema(db)
    const row = db.prepare('SELECT * FROM study_dossiers WHERE run_id = ?').get(runId) as StudyDossierRow | undefined
    return row ? rowToDossier(row) : null
  }

  static list(): NovelStudyDossier[] {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    ensureStudyDossierSchema(db)
    const rows = db.prepare('SELECT * FROM study_dossiers ORDER BY created_at DESC').all() as StudyDossierRow[]
    return rows.map(rowToDossier)
  }

  static delete(id: string): boolean {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    ensureStudyDossierSchema(db)
    const result = db.prepare('DELETE FROM study_dossiers WHERE id = ?').run(id)
    return result.changes > 0
  }

  static updateFromImportEffect(runId: string, kind: string, payloadJson: string): void {
    const db = getProjectDb()
    if (!db) return
    ensureStudyDossierSchema(db)
    let existing = this.getByRunId(runId)
    if (!existing) {
      const runRow = db.prepare('SELECT * FROM import_runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined
      let sourceDisplay: Array<{ displayName: string; size?: number }> = []
      try {
        if (typeof runRow?.source_display_json === 'string') {
          sourceDisplay = JSON.parse(runRow.source_display_json)
        }
      } catch { /* 容错 */ }
      const title = sourceDisplay[0]?.displayName || `研习档案 ${runId}`
      const sourceFiles = sourceDisplay.map(s => ({ name: s.displayName, size: s.size ?? 0 }))
      existing = {
        id: `study-${runId}`,
        runId,
        title,
        sourceFiles,
        totalChapters: Number(runRow?.total_chapters) || 0,
        totalWords: Number(runRow?.manifest_word_count) || 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        styleProfile: {
          pacingAndStructure: '',
          syntaxAndScene: '',
          dialogueAndEmotion: '',
          actionableTechniques: [],
          cautions: [],
          rawAnalysis: '',
        },
        inferredOutline: {
          genre: '', subGenre: '', targetAudience: '', plotStructure: 'three_act', narrativePov: 'third_limited',
          coreOutline: '', worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '',
          premise: '', worldbuilding: '', synopsis: '',
        },
        characterCards: [],
        blueprints: [],
      }
    }

    try {
      const payload = JSON.parse(payloadJson)
      if (kind === 'project-global-facts') {
        if (payload.core) existing.inferredOutline = { ...existing.inferredOutline, ...payload.core }
        if (Array.isArray(payload.characterEntries)) existing.characterCards = payload.characterEntries
      } else if (kind === 'project-writing-style') {
        if (typeof payload.writingStyle === 'string') {
          existing.styleProfile.rawAnalysis = payload.writingStyle
        }
      } else if (kind === 'chapter-blueprint-range') {
        if (Array.isArray(payload.blueprints)) {
          const bpMap = new Map(existing.blueprints.map(b => [b.chapterNumber, b]))
          for (const bp of payload.blueprints) {
            bpMap.set(bp.chapterNumber, bp)
          }
          existing.blueprints = Array.from(bpMap.values()).sort((a, b) => a.chapterNumber - b.chapterNumber)
        }
      }
      existing.updatedAt = new Date().toISOString()
      this.save(existing)
    } catch {
      // 容错处理
    }
  }

  static applyProjection(options: NovelStudyProjectionOptions): NovelStudyProjectionReceipt {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    const dossier = this.get(options.dossierId)
    if (!dossier) throw new Error(`研习档案 ${options.dossierId} 不存在`)

    return db.transaction(() => {
      let appliedStyle = false
      let appliedOutline = false
      let appliedCharactersCount = 0
      let appliedBlueprintsCount = 0

      // 1. 文风投影
      if (options.applyStyle && dossier.styleProfile?.rawAnalysis) {
        ProjectCoreRepository.update({ writingStyle: dossier.styleProfile.rawAnalysis })
        appliedStyle = true
      }

      // 2. 大纲与世界观投影
      if (options.applyOutline && dossier.inferredOutline) {
        const outline = dossier.inferredOutline
        ProjectCoreRepository.update({
          genre: outline.genre,
          subGenre: outline.subGenre,
          targetAudience: outline.targetAudience,
          plotStructure: outline.plotStructure,
          narrativePov: outline.narrativePov,
          goldenFinger: outline.goldenFinger,
          globalGuidance: outline.globalGuidance,
          coreOutline: outline.coreOutline,
          worldSetting: outline.worldSetting,
          protagonistProfile: outline.protagonistProfile,
          premise: outline.premise,
          worldbuilding: outline.worldbuilding,
          synopsis: outline.synopsis,
        })
        appliedOutline = true
      }

      // 3. 角色原型投影
      if (options.selectedCharacterNames && options.selectedCharacterNames.length > 0) {
        const nameSet = new Set(options.selectedCharacterNames)
        const selectedCards = dossier.characterCards.filter(card => nameSet.has(card.name))
        if (selectedCards.length > 0) {
          const currentRoster = CharacterRosterRepository.read()
          const operationId = `study-projection-${dossier.id}-chars-${Date.now()}`
          const normalizedEntries = selectedCards.map(card => {
            const raw = card as unknown as Record<string, unknown>
            const rawState = raw.currentState && typeof raw.currentState === 'object' && Number.isSafeInteger((raw.currentState as Record<string, unknown>).updatedAtChapter)
              ? (raw.currentState as Record<string, unknown>)
              : undefined
            return {
              name: card.name,
              role: card.role || 'supporting',
              gender: typeof raw.gender === 'string' && raw.gender ? raw.gender : '未知',
              age: raw.age !== undefined && raw.age !== null ? raw.age : '未知',
              appearance: card.appearance || '暂无描述',
              personality: card.personality || '暂无描述',
              background: card.background || '暂无描述',
              abilities: card.abilities || '暂无描述',
              motivation: card.motivation || '暂无描述',
              arc: typeof raw.arc === 'string' && raw.arc ? raw.arc : '暂无描述',
              notes: card.notes || '',
              relationships: Array.isArray(card.relationships) ? card.relationships : [],
              ...(rawState ? { currentState: rawState } : {}),
            }
          })
          CharacterRosterRepository.commit({
            operationId,
            expectedRevision: currentRoster.revision,
            schemaVersion: 1,
            intent: 'novel_import',
            entries: normalizedEntries as never,
          })
          appliedCharactersCount = selectedCards.length
        }
      }

      // 4. 章节蓝图投影
      if (options.selectedBlueprintRange && dossier.blueprints.length > 0) {
        const { startChapter, endChapter } = options.selectedBlueprintRange
        const selectedBlueprints = dossier.blueprints.filter(
          bp => bp.chapterNumber >= startChapter && bp.chapterNumber <= endChapter,
        )
        if (selectedBlueprints.length > 0) {
          const operationId = `study-projection-${dossier.id}-bp-${Date.now()}`
          const normalizedBlueprints = selectedBlueprints.map(bp => ({
            chapterNumber: bp.chapterNumber,
            title: bp.title,
            role: bp.role || '发展',
            purpose: bp.purpose || '',
            keyEvents: bp.keyEvents || '',
            characters: Array.isArray(bp.characters) ? bp.characters : [],
            suspenseHook: bp.suspenseHook || '',
            userGuidance: '',
            notes: '',
            notesUpdatedAt: '',
          }))
          BlueprintRepository.commitRange({
            mode: 'replace-range',
            operationId,
            startChapter,
            endChapter,
            blueprints: normalizedBlueprints as BlueprintRangeCommitRequest['blueprints'],
          })
          appliedBlueprintsCount = selectedBlueprints.length
        }
      }

      return {
        dossierId: dossier.id,
        appliedAt: new Date().toISOString(),
        appliedStyle,
        appliedOutline,
        appliedCharactersCount,
        appliedBlueprintsCount,
      }
    })()
  }
}
