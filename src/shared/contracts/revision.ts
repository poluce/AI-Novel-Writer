import type { ExpectedDraftSource } from './draft'

export interface RevisionMeta {
  id: number
  baseDraftId: number
  revisionIndex: number
  revisionType: string
  status: string
  mergedToDraftId: number | null
  userPrompt: string
  reviewSourceId: number | null
  contentId: number
  wordCount: number
  createdAt: string
  updatedAt: string
}

export interface RevisionFull extends RevisionMeta {
  content: string
  sourceDraft: ExpectedDraftSource | null
}

export interface MergeRevisionRequest {
  revisionId: number
  targetDraftId: number
  expectedDraftContent: string
  mergedContent: string
  wordCount: number
}

export interface MergeRevisionReceipt {
  revisionId: number
  targetDraftId: number
  status: 'revised'
  wordCount: number
  idempotent: boolean
}
