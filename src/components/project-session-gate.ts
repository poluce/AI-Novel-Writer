import type { ProjectData, ProjectSessionContext } from '../shared/ipc-channels'
import {
  getActiveProjectSessionContext,
  projectSessionContextFromProject,
  sameProjectPathKey,
  sameProjectSessionContext} from '../shared/project-session-context'

type SessionProject = Pick<ProjectData, 'id' | 'path'>

/**
 * Freeze the rendered project's identity before starting async UI work.
 */
export function captureProjectSession(
  project: SessionProject | null | undefined,
): ProjectSessionContext | null {
  const candidate = projectSessionContextFromProject(project)
  if (!candidate) return null

  const active = getActiveProjectSessionContext()
  return sameProjectSessionContext(candidate, active) ? candidate : null
}

/** True only while the same project id and path remain active. */
export function isProjectSessionCurrent(
  session: ProjectSessionContext | null | undefined,
): session is ProjectSessionContext {
  return !!session && sameProjectSessionContext(session, getActiveProjectSessionContext())
}

/** Safe for matching an event payload to a session without treating a path as a lease. */
export function isProjectSessionPath(
  session: ProjectSessionContext | null | undefined,
  projectPath: string | null | undefined,
): boolean {
  return !!session && sameProjectPathKey(session.projectPath, projectPath)
}
