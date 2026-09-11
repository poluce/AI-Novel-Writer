/**
 * Shared abort table for every in-flight pi-ai request: multi-turn Agent
 * sessions and one-shot submit_* streams. Book switch / cancel-all abort
 * this table; they must not invent a second AbortController map.
 */

export interface PiAbortable {
  abort(): void
}

const inFlight = new Map<string, PiAbortable>()

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

export function piInFlightCount(): number {
  return inFlight.size
}

/** Test-only: drop the table without aborting. */
export function resetPiInFlightForTests(): void {
  inFlight.clear()
}
