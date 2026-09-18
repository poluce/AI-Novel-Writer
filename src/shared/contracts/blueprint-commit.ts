import type { BlueprintData } from '../blueprint'

export type BlueprintRangeCommitMode = 'full' | 'replace-range'

export interface BlueprintRangeCommitRequest {
  mode: BlueprintRangeCommitMode
  operationId: string
  startChapter: number
  endChapter: number
  blueprints: BlueprintData[]
}

export interface BlueprintCharacterSyncCompletionReceipt {
  blueprintCommitOperationId: string
  operationId: string
  status: 'committed' | 'already-satisfied'
  rosterReceipt?: {
    operationId: string
    payloadHash: string
    revision: number
    idempotent: boolean
  }
}

export interface BlueprintCharacterSyncOperation {
  operationId: string
  blueprintCommitOperationId: string
  blueprintCommitPayloadHash: string
  status: 'pending' | 'completed'
  startChapter: number
  endChapter: number
  characterSyncInput: BlueprintData[]
  completionReceipt?: BlueprintCharacterSyncCompletionReceipt
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export interface BlueprintRangeCommitReceipt {
  mode: BlueprintRangeCommitMode
  operationId: string
  payloadHash: string
  idempotent: boolean
  startChapter: number
  endChapter: number
  chapterNumbers: number[]
  snapshot: BlueprintData[]
  characterSyncInput: BlueprintData[]
  characterSyncOperation: BlueprintCharacterSyncOperation
}
