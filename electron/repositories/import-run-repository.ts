import type { ImportRunExecutionAuthority } from '../../src/shared/import-run'
import { assertExecutionAuthority } from './import-run-store'
import {
  parsedSourceStatus,
  beginParsing,
  commitParsedSource,
  failParsedSource,
  finalizeParsing,
  prepare,
} from './import-run-parsing'
import {
  resolveReferenceImportAuthority,
  commitReferenceImportReceipt,
} from './import-run-reference'
import {
  getRun,
  listResumable,
  listChapterBatch,
} from './import-run-store'
import {
  getEffectReceipt,
  prepareEffectReceipt,
  commitEffectReceipt,
} from './import-run-effects'
import {
  startOrResume,
  renewExecution,
  restart,
  requestCancel,
  cancelAtBoundary,
  completeBatch,
  advanceStage,
  fail,
  complete,
} from './import-run-execution'

export class ImportRunRepository {
  static parsedSourceStatus = parsedSourceStatus
  static assertExecutionAuthority(
    runId: string,
    authority: ImportRunExecutionAuthority,
    now = Date.now(),
  ): void {
    assertExecutionAuthority(runId, authority, now)
  }
  static resolveReferenceImportAuthority = resolveReferenceImportAuthority
  static commitReferenceImportReceipt = commitReferenceImportReceipt
  static beginParsing = beginParsing
  static commitParsedSource = commitParsedSource
  static failParsedSource = failParsedSource
  static finalizeParsing = finalizeParsing
  static prepare = prepare
  static get = getRun
  static listResumable = listResumable
  static listChapterBatch = listChapterBatch
  static getEffectReceipt = getEffectReceipt
  static prepareEffectReceipt = prepareEffectReceipt
  static commitEffectReceipt = commitEffectReceipt
  static startOrResume = startOrResume
  static renewExecution = renewExecution
  static restart = restart
  static requestCancel = requestCancel
  static cancelAtBoundary = cancelAtBoundary
  static completeBatch = completeBatch
  static advanceStage = advanceStage
  static fail = fail
  static complete = complete
}
