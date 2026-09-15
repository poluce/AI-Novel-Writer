/**
 * 助手作用域：一个跟着书走，一个跟着应用走。
 *
 * - `project`（项目助手）：会话与存档都在项目内（`<项目>/.vela/`），
 *   只有打开项目时才存在，能读项目资料、能发起工作流。
 * - `global`（界面助手）：会话与存档在应用数据目录（`~/.vela/`），
 *   没有项目时也一直可用；不带项目事实，也不挂项目读写工具。
 *
 * 作用域只决定「用哪份存档、挂哪些工具、系统提示词里有没有项目事实」，
 * 助手身份与对话体验是同一套。
 */
export const AGENT_SCOPES = ['project', 'global'] as const

export type AgentScope = typeof AGENT_SCOPES[number]

export const DEFAULT_AGENT_SCOPE: AgentScope = 'project'

export function isAgentScope(value: unknown): value is AgentScope {
  return AGENT_SCOPES.includes(value as AgentScope)
}
