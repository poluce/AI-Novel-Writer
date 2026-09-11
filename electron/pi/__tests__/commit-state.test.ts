import { describe, expect, it } from 'vitest'

import { afterUnknownCommit, commitStateFromDetails } from '../commit-state'

describe('afterUnknownCommit', () => {
  it('stops the agent when a write left an unknown commit state', () => {
    expect(afterUnknownCommit({ details: { commitState: 'unknown' } })).toEqual({
      terminate: true,
      isError: true,
    })
  })

  it('does not stop the agent after a committed or clean failed write', () => {
    expect(afterUnknownCommit({ details: { commitState: 'committed' } })).toBeUndefined()
    expect(afterUnknownCommit({ details: { commitState: 'not_committed' } })).toBeUndefined()
    expect(afterUnknownCommit({ details: { path: 'notes.md' } })).toBeUndefined()
  })

  it('reads only known commit states from details', () => {
    expect(commitStateFromDetails({ commitState: 'committed' })).toBe('committed')
    expect(commitStateFromDetails({ commitState: 'maybe' })).toBeUndefined()
  })
})
