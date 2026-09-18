import type {
  ImportRunChapterSnapshot,
  ImportRunDirectCheckpointStage,
  ImportRunEffectCommitResult,
  ImportRunEffectKind,
  ImportRunEffectReceipt,
  ImportRunExecutionAuthority,
  ImportRunExecutionLease,
  ImportRunSnapshot,
  ImportRunStartResult,
  ImportRunStage,
} from '../../shared/import-run'
import type { StepCallbacks } from '../../stores/workflow-store'

export const IMPORT_CHAPTER_PAGE_SIZE = 100
const IMPORT_RUN_HEARTBEAT_MAX_INTERVAL_MS = 60_000

export interface ImportRunExecutionContext {
  cancelled: boolean
}

export interface ImportRunExecutionState {
  current: ImportRunExecutionLease
  lost?: unknown
}

export type ImportRunGeneratedEffectCommitter<T> = (payload: unknown) => Promise<T>

export interface BaseLeaseBatchDependencies {
  getRun: (runId: string) => Promise<ImportRunSnapshot | null>
  startOrResume: (runId: string, owner: string) => Promise<ImportRunStartResult>
  renewExecution: (runId: string, execution: ImportRunExecutionLease) => Promise<ImportRunExecutionLease>
  getEffectReceipt: (
    runId: string,
    stage: ImportRunStage,
    batchId: string,
  ) => Promise<ImportRunEffectReceipt | null>
  prepareEffectReceipt: (
    request: {
      runId: string
      stage: ImportRunStage
      batchId: string
      effectKey: string
      kind: ImportRunEffectKind
      payload: unknown
    },
    execution: ImportRunExecutionLease,
  ) => Promise<ImportRunEffectReceipt>
  commitEffectReceipt: (
    runId: string,
    stage: ImportRunStage,
    batchId: string,
    execution: ImportRunExecutionLease,
  ) => Promise<ImportRunEffectCommitResult>
  replayCommittedEffect: (receipt: ImportRunEffectReceipt, run: ImportRunSnapshot) => Promise<void>
  listChapters: (
    runId: string,
    afterChapterNumber: number,
    limit: number,
  ) => Promise<ImportRunChapterSnapshot[]>
  refresh: (run: ImportRunSnapshot) => Promise<void>
  completeBatch: (
    runId: string,
    stage: ImportRunDirectCheckpointStage,
    batchId: string,
    execution: ImportRunExecutionLease,
  ) => Promise<{ cancelApplied: boolean; run: ImportRunSnapshot }>
  advanceStage: (
    runId: string,
    completedStage: ImportRunStage,
    nextStage: ImportRunStage,
    execution: ImportRunExecutionLease,
  ) => Promise<ImportRunSnapshot>
  fail: (runId: string, stage: ImportRunStage, error: string, execution: ImportRunExecutionLease) => Promise<ImportRunSnapshot>
  cancelAtBoundary: (runId: string, execution: ImportRunExecutionLease) => Promise<ImportRunSnapshot>
  complete: (runId: string, execution: ImportRunExecutionLease) => Promise<ImportRunSnapshot>
}

export function splitContiguousBatches(
  chapters: ImportRunChapterSnapshot[],
  maxBatchSize: number,
): ImportRunChapterSnapshot[][] {
  const batches: ImportRunChapterSnapshot[][] = []
  let current: ImportRunChapterSnapshot[] = []
  for (const chapter of chapters) {
    const previous = current.at(-1)
    if (current.length >= maxBatchSize || (previous && chapter.number !== previous.number + 1)) {
      batches.push(current)
      current = []
    }
    current.push(chapter)
  }
  if (current.length > 0) batches.push(current)
  return batches
}

export abstract class BaseLeaseBatchOrchestrator<TDeps extends BaseLeaseBatchDependencies = BaseLeaseBatchDependencies> {
  constructor(protected readonly dependencies: TDeps) {}

  protected async withLeaseHeartbeat<T>(
    runId: string,
    execution: ImportRunExecutionState,
    operation: (lease: {
      authority: ImportRunExecutionAuthority
      renew: () => Promise<ImportRunExecutionLease>
    }) => Promise<T>,
  ): Promise<{ value: T; execution: ImportRunExecutionLease }> {
    const initialAuthority = {
      owner: execution.current.owner,
      epoch: execution.current.epoch,
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    let heartbeatError: unknown
    let renewalTail = Promise.resolve()

    const renew = (): Promise<ImportRunExecutionLease> => {
      const renewal = renewalTail.then(async () => {
        if (heartbeatError) throw heartbeatError
        try {
          const renewed = await this.dependencies.renewExecution(runId, execution.current)
          if (renewed.owner !== initialAuthority.owner || renewed.epoch !== initialAuthority.epoch) {
            throw new Error('Import execution authority changed during lease renewal.')
          }
          execution.current = renewed
          return execution.current
        } catch (error) {
          heartbeatError = error
          execution.lost = error
          throw error
        }
      })
      renewalTail = renewal.then(() => undefined, () => undefined)
      return renewal
    }

    const schedule = () => {
      if (stopped || heartbeatError) return
      const remaining = Math.max(1, execution.current.expiresAt - Date.now())
      const delay = Math.max(1, Math.min(
        IMPORT_RUN_HEARTBEAT_MAX_INTERVAL_MS,
        Math.floor(remaining / 3),
      ))
      timer = setTimeout(() => {
        if (stopped || heartbeatError) return
        void renew()
          .then(() => {
            schedule()
          })
          .catch(() => undefined)
      }, delay)
    }

    await renew()
    schedule()
    let outcome: { ok: true; value: T } | { ok: false; error: unknown }
    try {
      outcome = {
        ok: true,
        value: await operation({
          authority: initialAuthority,
          renew,
        }),
      }
    } catch (error) {
      outcome = { ok: false, error }
    } finally {
      stopped = true
      if (timer) clearTimeout(timer)
      await renewalTail
    }
    if (heartbeatError) throw heartbeatError
    if (!outcome.ok) throw outcome.error
    return { value: outcome.value, execution: execution.current }
  }

  protected async executeDurableEffect(
    run: ImportRunSnapshot,
    execution: ImportRunExecutionState,
    stage: ImportRunStage,
    batchId: string,
    effectKey: string,
    kind: ImportRunEffectKind,
    generate: (commit: ImportRunGeneratedEffectCommitter<unknown>) => Promise<void>,
  ): Promise<{ run: ImportRunSnapshot; execution: ImportRunExecutionLease }> {
    const existing = await this.dependencies.getEffectReceipt(run.id, stage, batchId)
    if (existing) {
      execution.current = await this.dependencies.renewExecution(run.id, execution.current)
      const committed = await this.dependencies.commitEffectReceipt(
        run.id, stage, batchId, execution.current,
      )
      await this.withLeaseHeartbeat(
        run.id,
        execution,
        () => this.dependencies.replayCommittedEffect(committed.receipt, committed.run),
      )
      return { run: committed.run, execution: execution.current }
    }
    const keptAlive = await this.withLeaseHeartbeat(run.id, execution, lease => generate(async payload => {
      execution.current = await lease.renew()
      await this.dependencies.prepareEffectReceipt({
        runId: run.id, stage, batchId, effectKey, kind, payload,
      }, execution.current)
      execution.current = await lease.renew()
      const committed = await this.dependencies.commitEffectReceipt(
        run.id, stage, batchId, execution.current,
      )
      run = committed.run
      return committed.receipt.effectReceipt
    }))
    execution.current = keptAlive.execution
    const committedReceipt = await this.dependencies.getEffectReceipt(run.id, stage, batchId)
    if (!committedReceipt || committedReceipt.state !== 'committed') {
      throw new Error('Generated import effect was not durably committed.')
    }
    return { run, execution: execution.current }
  }

  protected async replayCheckpointedEffect(
    run: ImportRunSnapshot,
    execution: ImportRunExecutionState,
    stage: ImportRunStage,
    batchId: string,
  ): Promise<{ run: ImportRunSnapshot; execution: ImportRunExecutionLease }> {
    const existing = await this.dependencies.getEffectReceipt(run.id, stage, batchId)
    if (!existing) {
      throw new Error('A completed import checkpoint is missing its durable effect receipt.')
    }
    execution.current = await this.dependencies.renewExecution(run.id, execution.current)
    const committed = await this.dependencies.commitEffectReceipt(
      run.id, stage, batchId, execution.current,
    )
    await this.withLeaseHeartbeat(
      run.id,
      execution,
      () => this.dependencies.replayCommittedEffect(committed.receipt, committed.run),
    )
    return { run: committed.run, execution: execution.current }
  }

  protected async executeRefresh(
    run: ImportRunSnapshot,
    execution: ImportRunExecutionState,
    context: ImportRunExecutionContext,
    callbacks: StepCallbacks,
  ): Promise<void> {
    if (!run.completedBatches.refresh?.includes('done')) {
      if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
      await this.withLeaseHeartbeat(run.id, execution, () => this.dependencies.refresh(run))
      execution.current = await this.dependencies.renewExecution(run.id, execution.current)
      await this.dependencies.completeBatch(run.id, 'refresh', 'done', execution.current)
    }
    callbacks.setProgress(100)
    if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
    execution.current = await this.dependencies.renewExecution(run.id, execution.current)
    await this.dependencies.complete(run.id, execution.current)
  }

  protected async handleExecutionFailure(
    runId: string,
    requestedStage: ImportRunStage,
    execution: ImportRunExecutionState,
    context: ImportRunExecutionContext,
    error: unknown,
  ): Promise<never> {
    if (execution.lost) throw error
    if (context.cancelled) {
      try {
        execution.current = await this.dependencies.renewExecution(runId, execution.current)
        await this.dependencies.cancelAtBoundary(runId, execution.current)
      } catch (leaseError) {
        execution.lost = leaseError
        throw error
      }
    } else {
      try {
        execution.current = await this.dependencies.renewExecution(runId, execution.current)
        await this.dependencies.fail(
          runId,
          requestedStage,
          error instanceof Error ? error.message : String(error),
          execution.current,
        )
      } catch (leaseError) {
        execution.lost = leaseError
        throw error
      }
    }
    throw error
  }
}
