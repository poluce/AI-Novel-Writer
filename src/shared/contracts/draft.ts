import type { DraftSourceDependency } from '../draft-source-dependency'
import type { DraftStatus } from '../draft-status'

export interface DraftMeta {
  id: number
  chapterNumber: number
  chapterTitle?: string
  version: number
  status: string
  source: string
  contentId: number
  wordCount: number
  sourceDependencies: DraftSourceDependency[]
  dependenciesStale: boolean
  createdAt: string
  updatedAt: string
}

export interface DraftFull extends DraftMeta {
  content: string
}

/** 渲染层捕获、主进程写事务再校验的来源草稿合同。 */
export interface ExpectedDraftSource {
  id: number
  chapterNumber: number
  version: number
  status: DraftStatus
  content: string
}
