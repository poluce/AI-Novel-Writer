import type { ProjectData, ProjectSessionContext } from '../shared/ipc-channels'
import {
  projectSessionContextFromProject,
  sameProjectPathKey,
  sameProjectSessionContext,
} from '../shared/project-session-context'
import { useProjectStore } from '../stores/project-store'

/** 其它 Store 读当前项目时走这里，不要直接 useProjectStore.getState()。 */
export function readActiveProject(): ProjectData | null {
  return useProjectStore.getState().currentProject
}

export function readActiveProjectSession(): ProjectSessionContext | null {
  return projectSessionContextFromProject(readActiveProject())
}

export function isActiveProjectSession(session: ProjectSessionContext): boolean {
  return sameProjectSessionContext(session, readActiveProjectSession())
}

export function matchActiveProjectSession(
  expectedProjectPath?: string,
  expectedProjectSession?: ProjectSessionContext,
): ProjectSessionContext | null {
  const project = readActiveProject()
  const projectSession = projectSessionContextFromProject(project)
  if (
    !project
    || !projectSession
    || (expectedProjectPath && !sameProjectPathKey(project.path, expectedProjectPath))
    || (expectedProjectSession && !sameProjectSessionContext(expectedProjectSession, projectSession))
  ) return null
  return projectSession
}
