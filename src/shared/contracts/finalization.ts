export type PublicationStatus = 'pending' | 'published'

export interface FinalizationCommitInput {
  finalizationId: string
  draftId: number
  chapterNumber: number
  chapterTitle: string
  content: string
  contentHash: string
  contentRevision: number
  targetFileName: string
}

export interface FinalizationRecord {
  finalizationId: string
  draftId: number
  chapterNumber: number
  chapterTitle: string
  contentSnapshot: string
  contentHash: string
  contentRevision: number
  targetFileName: string
  knowledgeDocumentId: string
  publicationStatus: PublicationStatus
  lastError: string
  publishedAt: string | null
}

export interface FinalizedDraftExportSnapshot {
  draftId: number
  chapterNumber: number
  version: number
  title: string
  content: string
  finalizationId: string | null
  contentHash: string
}

export type FinalizedDraftExportAuthorityReceipt = ReadonlyArray<Readonly<{
  draftId: number
  chapterNumber: number
  version: number
  finalizationId: string | null
  contentHash: string
}>>

export interface FinalizationResult {
  success: boolean
  committed: boolean
  finalizationId?: string
  contentHash?: string
  contentRevision?: number
  draftId?: number
  publicationStatus?: PublicationStatus
  error?: string
}
