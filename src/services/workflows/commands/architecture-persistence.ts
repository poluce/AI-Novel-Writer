import { useProjectStore } from '../../../stores/project-store'
import { ipc } from '../../ipc-client'
import { requireIpcSuccess } from '../../ipc-result'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import { workflowUiText } from '../workflow-project-session'
import type { NovelConfig, ProjectSessionContext } from '../../../shared/ipc-channels'
import type { CommandExecuteParams } from './base-command'
import { globalEventBus } from '../../../shared/event-bus'
import type { PartialArchData } from './plot-outline-checkpoint'

export interface ArchitectureProjectSnapshot {
  expectedProjectPath: string
  novelConfig: Readonly<NovelConfig>
}

export function emitArchFileUpdated(
  fileName: string,
  expectedProjectPath: string,
  projectSession: ProjectSessionContext,
  runId: string,
): void {
  globalEventBus.emit('ARCH_FILE_UPDATED', {
    fileName,
    projectPath: expectedProjectPath,
    projectSession,
    runId,
  })
}

export function assertArchitectureProjectSessionCurrent(
  projectSession: ProjectSessionContext,
  context: CommandExecuteParams['context'],
): void {
  if (!sameProjectSessionContext(
    projectSession,
    projectSessionContextFromProject(useProjectStore.getState().currentProject),
  )) {
    throw new Error(workflowUiText(
      context,
      '当前项目已切换，架构生成已停止以避免写入错误项目',
      'The current project changed, so architecture generation stopped to avoid writing to the wrong project.',
    ))
  }
}

export async function loadPartialData(
  projectPath: string,
  projectSession: ProjectSessionContext,
): Promise<PartialArchData> {
  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'fs:read-json',
    `${projectPath}/.vela/partial_arch.json`,
    projectPath,
  )
  if (result.success && result.data) return result.data as PartialArchData
  return {}
}

export async function savePartialData(
  projectPath: string,
  data: PartialArchData,
  projectSession: ProjectSessionContext,
  operationLabel: string,
  fallbackMessage?: string,
): Promise<void> {
  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'fs:write-json',
    `${projectPath}/.vela/partial_arch.json`,
    data,
    projectPath,
  )
  requireIpcSuccess(result, operationLabel, fallbackMessage)
}

export async function writeArchToDb(
  key: 'premise' | 'charactersArch' | 'worldbuilding' | 'synopsis',
  content: string,
  expectedProjectPath: string,
  runId: string,
  projectSession: ProjectSessionContext,
  fallbackError: string,
): Promise<void> {
  const cleanContent = content.trim()
  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'db:project-core-update',
    { [key]: cleanContent },
    expectedProjectPath,
  )
  requireIpcSuccess(result, 'db:project-core-update', fallbackError)

  emitArchFileUpdated(`${key}.md`, expectedProjectPath, projectSession, runId)
}
