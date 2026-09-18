import type { ExpectedDraftSource } from './draft'

export interface ReviewMeta {
  id: number
  baseDraftId: number
  reviewIndex: number
  contentId: number
  createdAt: string
}

export interface ReviewFull extends ReviewMeta {
  content: string
  sourceDraft: ExpectedDraftSource | null
}
