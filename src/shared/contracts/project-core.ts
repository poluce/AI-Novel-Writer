import type { CreativeStrategy } from '../reasoning-types'
import type { WritingLanguage } from '../writing-language'

/** 项目主台账的前端驼峰形状。 */
export interface ProjectCoreData {
  projectName: string
  genre: string
  subGenre: string
  targetAudience: string
  totalChapters: number
  wordsPerChapter: number
  writingLanguage: WritingLanguage
  creativeStrategy: CreativeStrategy
  narrativeThreadDormantChapterThreshold: number
  plotStructure: string
  narrativePov: string
  writingStyle: string
  referenceWorks: string
  globalGuidance: string
  goldenFinger: string
  coreOutline: string
  worldSetting: string
  protagonistProfile: string
  premise: string
  worldbuilding: string
  charactersArch: string
  synopsis: string
  characterStates: string
}

export type ProjectCoreSynopsisExpected = Pick<ProjectCoreData,
  | 'synopsis'
  | 'premise'
  | 'charactersArch'
  | 'worldbuilding'
  | 'genre'
  | 'totalChapters'
  | 'wordsPerChapter'
  | 'writingLanguage'
  | 'plotStructure'
  | 'narrativePov'
  | 'globalGuidance'
>

export interface ProjectCoreSynopsisCommitRequest {
  synopsis: string
  expected: ProjectCoreSynopsisExpected
}
