import { afterEach, describe, expect, it } from 'vitest'

import {
  captureProjectSession,
  isProjectSessionCurrent,
} from '../project-session-gate'
import {
  getActiveProjectSessionContext,
  setActiveProjectSessionContext,
} from '../../shared/project-session-context'

const project = {
  id: 'project-a',
  path: 'C:\\NovelA',
}

afterEach(() => {
  setActiveProjectSessionContext(null)
})

describe('component project session gate', () => {
  it('keeps a frozen session current when the same book is reopened at an equivalent path', () => {
    setActiveProjectSessionContext({
      projectId: project.id,
      projectPath: project.path,
    })
    const frozen = captureProjectSession(project)

    expect(frozen).toEqual({
      projectId: 'project-a',
      projectPath: 'C:\\NovelA',
    })
    expect(isProjectSessionCurrent(frozen)).toBe(true)

    setActiveProjectSessionContext({
      projectId: project.id,
      projectPath: 'c:/NovelA/.',
    })

    expect(getActiveProjectSessionContext()?.projectPath).toBe('c:/NovelA/.')
    expect(isProjectSessionCurrent(frozen)).toBe(true)
  })

  it('fails closed when the rendered project no longer owns the active session', () => {
    setActiveProjectSessionContext({
      projectId: 'project-b',
      projectPath: 'C:\\NovelB',
    })

    expect(captureProjectSession(project)).toBeNull()
  })
})
