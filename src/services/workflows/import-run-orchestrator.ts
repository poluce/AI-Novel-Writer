import type {
  ImportRunChapterSnapshot,
  ImportRunExecutionAuthority,
  ImportRunSnapshot,
  ImportRunStage,
} from '../../shared/import-run'
import {
  IMPORT_RUN_BLUEPRINT_BATCH_SIZE,
  IMPORT_RUN_KNOWLEDGE_BATCH_SIZE,
} from '../../shared/import-run'
import type { StepCallbacks } from '../../stores/workflow-store'
import type { FinalizedDraftImportDraftReceipt, FinalizedDraftImportReceipt } from '../../shared/finalized-draft-import'
import {
  BaseLeaseBatchOrchestrator,
  type BaseLeaseBatchDependencies,
  IMPORT_CHAPTER_PAGE_SIZE,
  type ImportRunExecutionContext,
  type ImportRunGeneratedEffectCommitter,
} from './lease-batch-orchestrator'
import {
  NovelStudyOrchestrator,
  type NovelStudyOrchestratorDependencies,
  STUDY_STAGES,
} from './novel-study-orchestrator'
import {
  AuthorManuscriptImportOrchestrator,
  type AuthorManuscriptImportOrchestratorDependencies,
  AUTHOR_STAGES,
} from './author-manuscript-import-orchestrator'

export {
  IMPORT_CHAPTER_PAGE_SIZE,
  type ImportRunExecutionContext,
  type ImportRunGeneratedEffectCommitter,
  BaseLeaseBatchOrchestrator,
  type BaseLeaseBatchDependencies,
}
export {
  NovelStudyOrchestrator,
  type NovelStudyOrchestratorDependencies,
  STUDY_STAGES,
}
export {
  AuthorManuscriptImportOrchestrator,
  type AuthorManuscriptImportOrchestratorDependencies,
  AUTHOR_STAGES,
}
export const IMPORT_KNOWLEDGE_BATCH_SIZE = IMPORT_RUN_KNOWLEDGE_BATCH_SIZE
export const IMPORT_BLUEPRINT_BATCH_SIZE = IMPORT_RUN_BLUEPRINT_BATCH_SIZE

export interface ImportRunOrchestratorDependencies extends BaseLeaseBatchDependencies {
  importReference?: (
    chapter: ImportRunChapterSnapshot,
    run: ImportRunSnapshot,
    executionAuthority: ImportRunExecutionAuthority,
  ) => Promise<void>
  inferGlobal?: (
    chapters: ImportRunChapterSnapshot[],
    stats: { totalChapters: number; totalWords: number },
    run: ImportRunSnapshot,
    commit: ImportRunGeneratedEffectCommitter<unknown>,
  ) => Promise<void>
  analyzeStyle?: (
    chapters: ImportRunChapterSnapshot[],
    run: ImportRunSnapshot,
    commit: ImportRunGeneratedEffectCommitter<unknown>,
  ) => Promise<void>
  inferBlueprints?: (
    chapters: ImportRunChapterSnapshot[],
    batchId: string,
    run: ImportRunSnapshot,
    commit: ImportRunGeneratedEffectCommitter<unknown>,
  ) => Promise<void>
  commitAuthorManuscript?: (
    run: ImportRunSnapshot,
    commit: ImportRunGeneratedEffectCommitter<unknown>,
  ) => Promise<void>
  getAuthorCommitReceipt?: (runId: string) => Promise<FinalizedDraftImportReceipt | null>
  publishAuthorChapter?: (
    chapter: ImportRunChapterSnapshot,
    draft: FinalizedDraftImportDraftReceipt,
    run: ImportRunSnapshot,
  ) => Promise<void>
  postprocessAuthorChapter?: (
    chapter: ImportRunChapterSnapshot,
    draft: FinalizedDraftImportDraftReceipt,
    run: ImportRunSnapshot,
  ) => Promise<void>
}

export class ImportRunOrchestrator {
  constructor(private readonly dependencies: ImportRunOrchestratorDependencies) {}

  async executeStage(
    runId: string,
    requestedStage: Exclude<ImportRunStage, 'completed'>,
    executionOwner: string,
    context: ImportRunExecutionContext,
    callbacks: StepCallbacks,
  ): Promise<void> {
    const existing = await this.dependencies.getRun(runId)
    if (!existing) throw new Error('Import run does not exist.')
    if (existing.purpose === 'author-manuscript') {
      const author = new AuthorManuscriptImportOrchestrator(
        this.dependencies as AuthorManuscriptImportOrchestratorDependencies,
      )
      return author.executeStage(runId, requestedStage, executionOwner, context, callbacks)
    }
    const study = new NovelStudyOrchestrator(
      this.dependencies as NovelStudyOrchestratorDependencies,
    )
    return study.executeStage(runId, requestedStage, executionOwner, context, callbacks)
  }
}
