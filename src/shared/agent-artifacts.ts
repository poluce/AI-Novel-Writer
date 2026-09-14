/**
 * agent-artifacts — 助手消息里的「产物卡片」数据模型。
 *
 * 这是渲染层的 UI 模型，不是工具协议：主进程的工具通过 Pi 的
 * `AgentToolResult.details` 返回结构化结果，渲染层用
 * `artifactFromToolResult` 把 details 映射成卡片（文件已写入 / 工作流已启动 /
 * 已打开标签页），保持 Pi 迁移前的用户可见行为。
 */

import type { ProjectSessionContext } from './ipc-channels'
import type { WorkflowStatus } from '../stores/workflow-store'

export interface ToolArtifactBase {
  /** 显示名称 */
  readonly name: string
  /** 归属项目 */
  readonly projectPath: string
  /** 冻结的项目会话，避免过期产物操作到别的项目 */
  readonly projectSession: ProjectSessionContext
}

export type ToolArtifact =
  | (ToolArtifactBase & {
    readonly type: 'file_created' | 'file_modified' | 'tab_opened'
    /** 文件路径或资源标识 */
    readonly path?: string
    readonly runId?: never
    readonly status?: never
  })
  | (ToolArtifactBase & {
    readonly type: 'workflow_started'
    /** A workflow artifact is itself an observable launch receipt. */
    readonly runId: string
    readonly status: WorkflowStatus
    readonly path?: never
  })

export function createToolArtifact<T extends ToolArtifact>(artifact: T): T {
  return Object.freeze({
    ...artifact,
    projectSession: Object.freeze({ ...artifact.projectSession }),
  }) as unknown as T
}

/** 产物卡片需要的项目身份；拿不到时不生成卡片。 */
export interface ArtifactContext {
  projectPath: string
  projectSession: ProjectSessionContext | null
}

function detailText(details: Record<string, unknown>, key: string): string | undefined {
  const value = details[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

/**
 * 把主进程工具的 details 映射成产物卡片；不产生产物的工具返回 null。
 *
 * 与 Pi 迁移前的行为一致：只有真正提交成功的文件写入、已完成注册的工作流
 * 启动，以及打开编辑器才会出现卡片。
 */
export function artifactFromToolResult(
  toolName: string,
  details: unknown,
  context: ArtifactContext,
): ToolArtifact | null {
  if (!context.projectSession) return null
  const record = details && typeof details === 'object' ? details as Record<string, unknown> : {}

  if (toolName === 'write_file') {
    if (record.commitState !== 'committed') return null
    const path = detailText(record, 'path')
    const name = detailText(record, 'name') ?? path
    if (!path || !name) return null
    return createToolArtifact({
      type: 'file_modified',
      name,
      path,
      projectPath: context.projectPath,
      projectSession: context.projectSession,
    })
  }

  if (toolName === 'start_workflow') {
    const runId = detailText(record, 'runId')
    if (!runId) return null
    return createToolArtifact({
      type: 'workflow_started',
      name: detailText(record, 'name') ?? runId,
      runId,
      status: (detailText(record, 'status') ?? 'running') as WorkflowStatus,
      projectPath: context.projectPath,
      projectSession: context.projectSession,
    })
  }

  if (toolName === 'open_editor') {
    const name = detailText(record, 'name')
    if (!name) return null
    const path = detailText(record, 'path')
    return createToolArtifact({
      type: 'tab_opened',
      name,
      ...(path ? { path } : {}),
      projectPath: context.projectPath,
      projectSession: context.projectSession,
    })
  }

  return null
}
