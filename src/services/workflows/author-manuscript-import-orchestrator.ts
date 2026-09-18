import type {
  ImportRunChapterSnapshot,
  ImportRunSnapshot,
  ImportRunStage,
} from '../../shared/import-run'
import type { FinalizedDraftImportDraftReceipt, FinalizedDraftImportReceipt } from '../../shared/finalized-draft-import'
import type { StepCallbacks } from '../../stores/workflow-store'
import {
  BaseLeaseBatchOrchestrator,
  type BaseLeaseBatchDependencies,
  type ImportRunExecutionContext,
  type ImportRunExecutionState,
  type ImportRunGeneratedEffectCommitter,
  IMPORT_CHAPTER_PAGE_SIZE,
} from './lease-batch-orchestrator'

export const AUTHOR_STAGES: ImportRunStage[] = [
  'author-commit',
  'author-publish',
  'author-postprocess',
  'refresh',
  'completed',
]

function requiredAuthorDependency<T>(value: T | undefined, name: string): T {
  if (!value) throw new Error(`Author-manuscript import dependency is unavailable: ${name}.`)
  return value
}

export interface AuthorManuscriptImportOrchestratorDependencies extends BaseLeaseBatchDependencies {
  commitAuthorManuscript: (
    run: ImportRunSnapshot,
    commit: ImportRunGeneratedEffectCommitter<unknown>,
  ) => Promise<void>
  getAuthorCommitReceipt: (runId: string) => Promise<FinalizedDraftImportReceipt | null>
  publishAuthorChapter: (
    chapter: ImportRunChapterSnapshot,
    draft: FinalizedDraftImportDraftReceipt,
    run: ImportRunSnapshot,
  ) => Promise<void>
  postprocessAuthorChapter: (
    chapter: ImportRunChapterSnapshot,
    draft: FinalizedDraftImportDraftReceipt,
    run: ImportRunSnapshot,
  ) => Promise<void>
}

export class AuthorManuscriptImportOrchestrator extends BaseLeaseBatchOrchestrator<AuthorManuscriptImportOrchestratorDependencies> {
  static stageIndex(stage: ImportRunStage): number {
    return AUTHOR_STAGES.indexOf(stage)
  }

  async executeStage(
    runId: string,
    requestedStage: Exclude<ImportRunStage, 'completed'>,
    executionOwner: string,
    context: ImportRunExecutionContext,
    callbacks: StepCallbacks,
  ): Promise<void> {
    const existing = await this.dependencies.getRun(runId)
    if (!existing) throw new Error('Import run does not exist.')
    const requestedIndex = AuthorManuscriptImportOrchestrator.stageIndex(requestedStage)
    if (requestedIndex < 0) {
      throw new Error(`Import stage ${requestedStage} does not belong to ${existing.purpose}.`)
    }
    if (existing.status === 'completed' || AuthorManuscriptImportOrchestrator.stageIndex(existing.stage) > requestedIndex) return
    const started = await this.dependencies.startOrResume(runId, executionOwner)
    const run = started.run
    const execution: ImportRunExecutionState = { current: started.execution }
    if (run.status === 'completed' || AuthorManuscriptImportOrchestrator.stageIndex(run.stage) > AuthorManuscriptImportOrchestrator.stageIndex(requestedStage)) return
    if (run.stage !== requestedStage) throw new Error(`Import run is waiting at ${run.stage}, not ${requestedStage}.`)

    try {
      switch (requestedStage) {
        case 'author-commit':
          await this.executeAuthorCommit(run, execution, context, callbacks)
          return
        case 'author-publish':
          await this.executeAuthorProjection(
            run, execution, context, callbacks, 'author-publish', 'author-postprocess',
          )
          return
        case 'author-postprocess':
          await this.executeAuthorProjection(
            run, execution, context, callbacks, 'author-postprocess', 'refresh',
          )
          return
        case 'refresh':
          await this.executeRefresh(run, execution, context, callbacks)
          return
        default:
          throw new Error(`Import stage ${requestedStage} does not belong to author manuscript import.`)
      }
    } catch (error) {
      await this.handleExecutionFailure(runId, requestedStage, execution, context, error)
    }
  }

  private async executeAuthorCommit(
    initialRun: ImportRunSnapshot,
    execution: ImportRunExecutionState,
    context: ImportRunExecutionContext,
    callbacks: StepCallbacks,
  ): Promise<void> {
    let run = initialRun
    if (!run.completedBatches['author-commit']?.includes('done')) {
      if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
      const commitAuthorManuscript = requiredAuthorDependency(
        this.dependencies.commitAuthorManuscript,
        'commitAuthorManuscript',
      )
      const committed = await this.executeDurableEffect(
        run,
        execution,
        'author-commit',
        'done',
        'author-finalized-batch',
        'author-finalized-batch',
        commit => commitAuthorManuscript(run, commit),
      )
      run = committed.run
      execution.current = committed.execution
    }
    callbacks.setProgress(100)
    if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
    execution.current = await this.dependencies.renewExecution(run.id, execution.current)
    await this.dependencies.advanceStage(run.id, 'author-commit', 'author-publish', execution.current)
  }

  private async executeAuthorProjection(
    initialRun: ImportRunSnapshot,
    execution: ImportRunExecutionState,
    context: ImportRunExecutionContext,
    callbacks: StepCallbacks,
    stage: 'author-publish' | 'author-postprocess',
    nextStage: 'author-postprocess' | 'refresh',
  ): Promise<void> {
    let run = initialRun
    const getReceipt = requiredAuthorDependency(
      this.dependencies.getAuthorCommitReceipt,
      'getAuthorCommitReceipt',
    )
    const projectChapter = stage === 'author-publish'
      ? requiredAuthorDependency(this.dependencies.publishAuthorChapter, 'publishAuthorChapter')
      : requiredAuthorDependency(this.dependencies.postprocessAuthorChapter, 'postprocessAuthorChapter')
    const receipt = await getReceipt(run.id)
    if (!receipt) throw new Error('The committed author-manuscript receipt is unavailable.')
    const draftsByChapter = new Map(receipt.drafts.map(draft => [draft.chapterNumber, draft]))
    let after = 0
    let visited = 0
    let page = await this.dependencies.listChapters(run.id, after, IMPORT_CHAPTER_PAGE_SIZE)
    while (page.length > 0) {
      for (const chapter of page) {
        const checkpoint = `chapter:${chapter.number}`
        if (!run.completedBatches[stage]?.includes(checkpoint)) {
          if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
          const draft = draftsByChapter.get(chapter.number)
          if (!draft) {
            throw new Error(`The author-manuscript receipt is missing Chapter ${chapter.number}.`)
          }
          execution.current = await this.dependencies.renewExecution(run.id, execution.current)
          await this.withLeaseHeartbeat(
            run.id,
            execution,
            () => projectChapter(chapter, draft, run),
          )
          execution.current = await this.dependencies.renewExecution(run.id, execution.current)
          const completed = await this.dependencies.completeBatch(
            run.id,
            stage,
            checkpoint,
            execution.current,
          )
          run = completed.run
        }
        visited += 1
        callbacks.setProgress(Math.min(99, Math.round((visited / run.totalChapters) * 100)))
        if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
      }
      after = page.at(-1)!.number
      page = await this.dependencies.listChapters(run.id, after, IMPORT_CHAPTER_PAGE_SIZE)
    }
    execution.current = await this.dependencies.renewExecution(run.id, execution.current)
    await this.dependencies.advanceStage(run.id, stage, nextStage, execution.current)
  }
}
