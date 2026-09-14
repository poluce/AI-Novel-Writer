import { useProjectStore } from '../../stores/project-store'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { Locale } from '../../i18n/types'
import {
  projectSessionContextFromProject,
  sameProjectSessionContext,
} from '../../shared/project-session-context'
import {
  DEFAULT_WRITING_LANGUAGE,
  resolveWritingLanguage,
  writingLanguageText,
  type WritingLanguage,
} from '../../shared/writing-language'

/**
 * 渲染层一次 Agent 请求的冻结上下文。模型侧的工具由主进程 Pi Agent 持有，
 * 这里保存的是渲染层必须冻结的身份信息（项目会话、模型、语言与取消信号），
 * 供请求构造与项目门禁使用。
 */
export interface AgentExecutionContext {
  readonly projectSession: ProjectSessionContext | null
  /** Visible interface language frozen for this complete Agent turn. */
  readonly uiLocale: Locale
  /** Model-facing language frozen for this complete Agent turn. */
  readonly writingLanguage: WritingLanguage
  /**
   * Model explicitly selected for this Agent turn. It is captured outside of
   * LLM tool arguments so a model response cannot choose a billable model.
   */
  readonly selectedModelId: string | null
  /** One tool call's cancellation signal; write tools check it before crossing their commit point. */
  readonly abortSignal?: AbortSignal
  /** Marks the point after which a transport failure cannot be reported as a clean rollback. */
  readonly markSideEffectStarted?: () => void
}

export const PROJECT_CHANGED_ERROR = '当前项目已切换，本次工具结果已丢弃'
export const PROJECT_CHANGED_ERROR_EN = 'The current project changed, so this tool result was discarded'
export const AGENT_TOOL_CANCELLED_ERROR = '本次工具操作已在提交前取消'
export const AGENT_TOOL_CANCELLED_ERROR_EN = 'This tool operation was cancelled before commit'

export function agentToolText(
  context: AgentExecutionContext | undefined,
  zhCN: string,
  enUS: string,
): string {
  return writingLanguageText(
    context?.writingLanguage ?? DEFAULT_WRITING_LANGUAGE,
    zhCN,
    enUS,
  )
}

export function createAgentExecutionContext(
  selectedModelId?: string | null,
  uiLocale: Locale = DEFAULT_WRITING_LANGUAGE,
): AgentExecutionContext {
  const frozenModelId = selectedModelId?.trim() || null
  const project = useProjectStore.getState().currentProject
  return Object.freeze({
    projectSession: projectSessionContextFromProject(project),
    selectedModelId: frozenModelId,
    uiLocale,
    writingLanguage: project
      ? resolveWritingLanguage(project.novelConfig.writingLanguage)
      : uiLocale,
  })
}

export function requireAgentProjectSession(
  context?: AgentExecutionContext,
): ProjectSessionContext {
  const session = context?.projectSession
  if (!session) {
    throw new Error(agentToolText(
      context,
      '缺少冻结项目会话，已拒绝工具项目访问',
      'No frozen project session is available; project tool access was denied',
    ))
  }
  return session
}

export function isAgentProjectCurrent(context?: AgentExecutionContext): boolean {
  const session = context?.projectSession
  return !!session && sameProjectSessionContext(
    session,
    projectSessionContextFromProject(useProjectStore.getState().currentProject),
  )
}

export function assertAgentProjectCurrent(context?: AgentExecutionContext): void {
  if (!isAgentProjectCurrent(context)) {
    throw new Error(agentToolText(
      context,
      PROJECT_CHANGED_ERROR,
      PROJECT_CHANGED_ERROR_EN,
    ))
  }
}
