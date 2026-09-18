import { describe, expect, it } from 'vitest'

import {
  isProjectSessionContext,
  projectPathKey,
  proposalBelongsToOpenProject,
  sameProjectPathKey} from '../project-session-context'

describe('renderer project path identity', () => {
  it('compares Windows project paths without casing, separator, dot-segment, or trailing-separator drift', () => {
    expect(projectPathKey('C:\\Novels\\Alpha\\')).toBe(projectPathKey('c:/novels/./ALPHA'))
    expect(sameProjectPathKey('C:\\Novels\\Alpha', 'c:/NOVELS/alpha/')).toBe(true)
    expect(sameProjectPathKey('C:\\Novels\\Alpha', 'C:\\Novels\\Beta')).toBe(false)
  })
})

describe('project session context runtime contract', () => {
  it('accepts the existing three-string session shape without imposing extra policy', () => {
    expect(isProjectSessionContext({
      projectId: '',
      projectPath: '',
      futureMetadata: 'accepted by the runtime shape guard'})).toBe(true)
  })

  it.each([
    null,
    undefined,
    'project-session',
    42,
    [],
    {},
    { projectId: 'project-1'},
    { projectId: 'project-1', projectPath: 42 },
    { projectId: ['project-1'], projectPath: 'C:\\Novel' },
  ])('rejects an invalid project session candidate: %j', (candidate) => {
    expect(isProjectSessionContext(candidate)).toBe(false)
  })
})

describe('proposalBelongsToOpenProject', () => {
  const project = { id: 'A', path: 'C:\\novels\\A' }

  it('treats a missing proposal session as the currently open project', () => {
    expect(proposalBelongsToOpenProject(null, project)).toBe(true)
    expect(proposalBelongsToOpenProject(undefined, project)).toBe(true)
    expect(proposalBelongsToOpenProject(null, null)).toBe(false)
  })

  it('ignores lease and keeps the same book after reopen', () => {
    expect(proposalBelongsToOpenProject(
      { projectId: 'A', projectPath: 'C:\\novels\\A' },
      { id: 'A', path: 'C:/novels/A' },
    )).toBe(true)
  })

  it('rejects a proposal from another book', () => {
    expect(proposalBelongsToOpenProject(
      { projectId: 'A', projectPath: 'C:\\novels\\A' },
      { id: 'B', path: 'C:\\novels\\B' },
    )).toBe(false)
  })
})
