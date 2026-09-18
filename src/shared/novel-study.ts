export interface NovelStudyStyleProfile {
  pacingAndStructure: string
  syntaxAndScene: string
  dialogueAndEmotion: string
  actionableTechniques: string[]
  cautions: string[]
  rawAnalysis: string
}

export interface NovelStudyInferredOutline {
  genre: string
  subGenre: string
  targetAudience: string
  plotStructure: string
  narrativePov: string
  coreOutline: string
  worldSetting: string
  goldenFinger: string
  protagonistProfile: string
  globalGuidance: string
  premise: string
  worldbuilding: string
  synopsis: string
}

export interface NovelStudyCharacterEntry {
  name: string
  role: string
  personality: string
  appearance: string
  background: string
  motivation: string
  abilities: string
  notes?: string
  currentState?: Record<string, unknown>
  relationships?: Array<{ target: string; relation: string }>
}

export interface NovelStudyChapterBlueprint {
  chapterNumber: number
  title: string
  role: string
  purpose: string
  characters: string[]
  keyEvents: string
  suspenseHook: string
}

export interface NovelStudyDossier {
  id: string
  runId: string
  title: string
  sourceFiles: Array<{ name: string; size: number }>
  totalChapters: number
  totalWords: number
  createdAt: string
  updatedAt: string
  styleProfile: NovelStudyStyleProfile
  inferredOutline: NovelStudyInferredOutline
  characterCards: NovelStudyCharacterEntry[]
  blueprints: NovelStudyChapterBlueprint[]
  knowledgePartitionId?: string
}

export interface NovelStudyProjectionOptions {
  dossierId: string
  applyStyle?: boolean
  applyOutline?: boolean
  selectedCharacterNames?: string[]
  selectedBlueprintRange?: { startChapter: number; endChapter: number }
}

export interface NovelStudyProjectionReceipt {
  dossierId: string
  appliedAt: string
  appliedStyle: boolean
  appliedOutline: boolean
  appliedCharactersCount: number
  appliedBlueprintsCount: number
}
