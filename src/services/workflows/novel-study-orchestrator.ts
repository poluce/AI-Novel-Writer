import type {
  ImportRunChapterSnapshot,
  ImportRunExecutionAuthority,
  ImportRunSnapshot,
  ImportRunStage,
} from '../../shared/import-run'
import {
  createImportRunChapterBatchCheckpointId,
  IMPORT_RUN_BLUEPRINT_BATCH_SIZE,
  IMPORT_RUN_KNOWLEDGE_BATCH_SIZE,
} from '../../shared/import-run'
import type { StepCallbacks } from '../../stores/workflow-store'
import {
  BaseLeaseBatchOrchestrator,
  type BaseLeaseBatchDependencies,
  type ImportRunExecutionContext,
  type ImportRunExecutionState,
  type ImportRunGeneratedEffectCommitter,
  IMPORT_CHAPTER_PAGE_SIZE,
  splitContiguousBatches,
} from './lease-batch-orchestrator'

export const STUDY_STAGES: ImportRunStage[] = [
  'knowledge',
  'global',
  'style',
  'blueprints',
  'refresh',
  'completed',
]

export interface NovelStudyOrchestratorDependencies extends BaseLeaseBatchDependencies {
  importReference: (
    chapter: ImportRunChapterSnapshot,
    run: ImportRunSnapshot,
    executionAuthority: ImportRunExecutionAuthority,
  ) => Promise<void>
  inferGlobal: (
    chapters: ImportRunChapterSnapshot[],
    stats: { totalChapters: number; totalWords: number },
    run: ImportRunSnapshot,
    commit: ImportRunGeneratedEffectCommitter<unknown>,
  ) => Promise<void>
  analyzeStyle: (
    chapters: ImportRunChapterSnapshot[],
    run: ImportRunSnapshot,
    commit: ImportRunGeneratedEffectCommitter<unknown>,
  ) => Promise<void>
  inferBlueprints: (
    chapters: ImportRunChapterSnapshot[],
    batchId: string,
    run: ImportRunSnapshot,
    commit: ImportRunGeneratedEffectCommitter<unknown>,
  ) => Promise<void>
}

export class NovelStudyOrchestrator extends BaseLeaseBatchOrchestrator<NovelStudyOrchestratorDependencies> {
  static stageIndex(stage: ImportRunStage): number {
    return STUDY_STAGES.indexOf(stage)
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
    const requestedIndex = NovelStudyOrchestrator.stageIndex(requestedStage)
    if (requestedIndex < 0) {
      throw new Error(`Import stage ${requestedStage} does not belong to ${existing.purpose}.`)
    }
    if (existing.status === 'completed' || NovelStudyOrchestrator.stageIndex(existing.stage) > requestedIndex) return
    const started = await this.dependencies.startOrResume(runId, executionOwner)
    const run = started.run
    const execution: ImportRunExecutionState = { current: started.execution }
    if (run.status === 'completed' || NovelStudyOrchestrator.stageIndex(run.stage) > NovelStudyOrchestrator.stageIndex(requestedStage)) return
    if (run.stage !== requestedStage) throw new Error(`Import run is waiting at ${run.stage}, not ${requestedStage}.`)

    try {
      switch (requestedStage) {
        case 'knowledge':
          await this.executeKnowledge(run, execution, context, callbacks)
          return
        case 'global':
          await this.executeGlobal(run, execution, context, callbacks)
          return
        case 'style':
          await this.executeStyle(run, execution, context, callbacks)
          return
        case 'blueprints':
          await this.executeBlueprints(run, execution, context, callbacks)
          return
        case 'refresh':
          await this.executeRefresh(run, execution, context, callbacks)
          return
        default:
          throw new Error(`Import stage ${requestedStage} does not belong to novel study.`)
      }
    } catch (error) {
      await this.handleExecutionFailure(runId, requestedStage, execution, context, error)
    }
  }

  private async executeKnowledge(
    initialRun: ImportRunSnapshot,
    execution: ImportRunExecutionState,
    context: ImportRunExecutionContext,
    callbacks: StepCallbacks,
  ): Promise<void> {
    let run = initialRun
    let after = 0
    let visited = 0
    let page = await this.dependencies.listChapters(run.id, after, IMPORT_CHAPTER_PAGE_SIZE)
    while (page.length > 0) {
      for (const batch of splitContiguousBatches(page, IMPORT_RUN_KNOWLEDGE_BATCH_SIZE)) {
        const checkpoint = createImportRunChapterBatchCheckpointId(batch)
        if (!run.completedBatches.knowledge?.includes(checkpoint)) {
          if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
          for (const chapter of batch) {
            execution.current = await this.dependencies.renewExecution(run.id, execution.current)
            await this.withLeaseHeartbeat(
              run.id,
              execution,
              lease => this.dependencies.importReference(
                chapter,
                run,
                lease.authority,
              ),
            )
          }
          execution.current = await this.dependencies.renewExecution(run.id, execution.current)
          const completed = await this.dependencies.completeBatch(
            run.id, 'knowledge', checkpoint, execution.current,
          )
          run = completed.run
        }
        visited += batch.length
        callbacks.setProgress(Math.min(99, Math.round((visited / run.totalChapters) * 100)))
        if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
      }
      after = page.at(-1)!.number
      page = await this.dependencies.listChapters(run.id, after, IMPORT_CHAPTER_PAGE_SIZE)
    }
    execution.current = await this.dependencies.renewExecution(run.id, execution.current)
    await this.dependencies.advanceStage(run.id, 'knowledge', 'global', execution.current)
  }

  private async representativeChapters(runId: string): Promise<ImportRunChapterSnapshot[]> {
    const first: ImportRunChapterSnapshot[] = []
    const last: ImportRunChapterSnapshot[] = []
    let after = 0
    let page = await this.dependencies.listChapters(runId, after, IMPORT_CHAPTER_PAGE_SIZE)
    while (page.length > 0) {
      for (const chapter of page) {
        if (first.length < 3) first.push(chapter)
        last.push(chapter)
        if (last.length > 2) last.shift()
      }
      after = page.at(-1)!.number
      page = await this.dependencies.listChapters(runId, after, IMPORT_CHAPTER_PAGE_SIZE)
    }
    const selected = new Map<number, ImportRunChapterSnapshot>()
    for (const chapter of [...first, ...last]) selected.set(chapter.number, chapter)
    return [...selected.values()].sort((a, b) => a.number - b.number)
  }

  private async executeGlobal(
    run: ImportRunSnapshot,
    execution: ImportRunExecutionState,
    context: ImportRunExecutionContext,
    callbacks: StepCallbacks,
  ): Promise<void> {
    if (!run.completedBatches.global?.includes('done')) {
      if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
      const sample = await this.representativeChapters(run.id)
      const committed = await this.executeDurableEffect(
        run, execution, 'global', 'done', 'global-facts', 'project-global-facts',
        commit => this.dependencies.inferGlobal(sample, {
          totalChapters: run.manifestChapterCount,
          totalWords: run.manifestWordCount,
        }, run, commit),
      )
      run = committed.run
      execution.current = committed.execution
    }
    callbacks.setProgress(100)
    if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
    execution.current = await this.dependencies.renewExecution(run.id, execution.current)
    await this.dependencies.advanceStage(run.id, 'global', 'style', execution.current)
  }

  private async executeStyle(
    run: ImportRunSnapshot,
    execution: ImportRunExecutionState,
    context: ImportRunExecutionContext,
    callbacks: StepCallbacks,
  ): Promise<void> {
    if (!run.completedBatches.style?.includes('done')) {
      if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
      const sample = await this.representativeChapters(run.id)
      const committed = await this.executeDurableEffect(
        run, execution, 'style', 'done', 'writing-style', 'project-writing-style',
        commit => this.dependencies.analyzeStyle(sample, run, commit),
      )
      run = committed.run
      execution.current = committed.execution
    }
    callbacks.setProgress(100)
    if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
    execution.current = await this.dependencies.renewExecution(run.id, execution.current)
    await this.dependencies.advanceStage(run.id, 'style', 'blueprints', execution.current)
  }

  private async executeBlueprints(
    run: ImportRunSnapshot,
    execution: ImportRunExecutionState,
    context: ImportRunExecutionContext,
    callbacks: StepCallbacks,
  ): Promise<void> {
    let after = 0
    let visited = 0
    let page = await this.dependencies.listChapters(run.id, after, IMPORT_CHAPTER_PAGE_SIZE)
    while (page.length > 0) {
      for (const batch of splitContiguousBatches(page, IMPORT_RUN_BLUEPRINT_BATCH_SIZE)) {
        const checkpoint = createImportRunChapterBatchCheckpointId(batch)
        if (run.completedBatches.blueprints?.includes(checkpoint)) {
          const replayed = await this.replayCheckpointedEffect(
            run,
            execution,
            'blueprints',
            checkpoint,
          )
          run = replayed.run
          execution.current = replayed.execution
        } else {
          if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
          const committed = await this.executeDurableEffect(
            run,
            execution,
            'blueprints',
            checkpoint,
            `blueprints:${checkpoint}`,
            'chapter-blueprint-range',
            commit => this.dependencies.inferBlueprints(batch, checkpoint, run, commit),
          )
          run = committed.run
          execution.current = committed.execution
        }
        visited += batch.length
        callbacks.setProgress(Math.min(99, Math.round((visited / run.totalChapters) * 100)))
        if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
      }
      after = page.at(-1)!.number
      page = await this.dependencies.listChapters(run.id, after, IMPORT_CHAPTER_PAGE_SIZE)
    }
    execution.current = await this.dependencies.renewExecution(run.id, execution.current)
    await this.dependencies.advanceStage(run.id, 'blueprints', 'refresh', execution.current)
  }
}
