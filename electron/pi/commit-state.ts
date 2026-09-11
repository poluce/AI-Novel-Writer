import type { AfterToolCallResult } from '@earendil-works/pi-agent-core'

import type { FileWriteCommitState } from '../../src/shared/ipc-channels'

export function commitStateFromDetails(details: unknown): FileWriteCommitState | undefined {
  if (!details || typeof details !== 'object' || !('commitState' in details)) return undefined
  const value = (details as { commitState?: unknown }).commitState
  return value === 'committed' || value === 'not_committed' || value === 'unknown' ? value : undefined
}

/**
 * If a write tool left the file in an unknown commit state, stop the agent
 * so it cannot automatically retry and double-write.
 */
export function afterUnknownCommit(result: { details?: unknown }): AfterToolCallResult | undefined {
  if (commitStateFromDetails(result.details) !== 'unknown') return undefined
  return { terminate: true, isError: true }
}
