/**
 * Shared abort table for every in-flight pi-ai request: multi-turn Agent
 * sessions and one-shot submit_* streams. Book switch / cancel-all abort
 * this table; they must not invent a second AbortController map.
 */

export interface PiAbortable {
  abort(): void
}

const inFlight = new Map<string, PiAbortable>()

/** One-shot submit_* streams only. Idle Agent sessions are not counted. */
export const PI_MAX_ONE_SHOT = 4

let oneShotActive = 0

export class PiConcurrencyError extends Error {
  readonly code = 'PI_CONCURRENCY' as const

  constructor(message = '已有太多进行中的 AI 请求，请等待当前任务完成后再试。') {
    super(message)
    this.name = 'PiConcurrencyError'
  }
}

/** Register an abortable request. The returned disposer is idempotent. */
export function registerPiInFlight(id: string, abortable: PiAbortable): () => void {
  inFlight.set(id, abortable)
  return () => {
    if (inFlight.get(id) === abortable) inFlight.delete(id)
  }
}

export function abortPiInFlight(id: string): boolean {
  const abortable = inFlight.get(id)
  if (!abortable) return false
  abortable.abort()
  return true
}

/** Abort every registered Agent session and one-shot stream. */
export function abortAllPiInFlight(): void {
  for (const abortable of [...inFlight.values()]) abortable.abort()
}

let projectCloseHook: () => void = abortAllPiInFlight

/** Agent IPC replaces this with session-manager.abortAll (also drops Agents). */
export function setPiProjectCloseHook(hook: () => void): void {
  projectCloseHook = hook
}

/** Called when the current project database is closing or switching. */
export function abortPiOnProjectClose(): void {
  projectCloseHook()
}

export function piInFlightCount(): number {
  return inFlight.size
}

/** Acquire a one-shot stream slot. The disposer is idempotent. */
export function acquirePiOneShotSlot(): () => void {
  if (oneShotActive >= PI_MAX_ONE_SHOT) throw new PiConcurrencyError()
  oneShotActive += 1
  let released = false
  return () => {
    if (released) return
    released = true
    oneShotActive = Math.max(0, oneShotActive - 1)
  }
}

export function piOneShotActiveCount(): number {
  return oneShotActive
}

/** Test-only: drop the table without aborting. */
export function resetPiInFlightForTests(): void {
  inFlight.clear()
  oneShotActive = 0
  projectCloseHook = abortAllPiInFlight
}
