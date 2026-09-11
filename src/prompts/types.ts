import type { WritingLanguage } from '../shared/writing-language'

/**
 * 一条提示词模板的完整形状。
 *
 * 散文字段（name / description / systemRole / taskGuidance / content /
 * systemSuffix）来自 ./zh-CN/*.md；结构字段（key / variables /
 * requiredContextVariables）来自 ./manifest.ts。
 */
export interface PromptTemplate {
  /** 模板唯一标识 */
  key: string
  /** Override language. Missing only on legacy files, which migrate to zh-CN. */
  writingLanguage?: WritingLanguage
  /** 显示名称 */
  name: string
  /** 用途说明 */
  description: string
  /** 模板内容（支持 {{变量}} 插值） */
  content: string
  /** 不可编辑的系统约束（提交工具字段语义等），渲染时自动追加到 content 末尾 */
  systemSuffix?: string
  /** LLM system message 角色定位（由模板统一定义，command 不再硬编码） */
  systemRole?: string
  /** 用户可编辑的补充创作指导；不可替换内置任务与输出合同。 */
  taskGuidance?: string
  /** 可用变量列表 */
  variables: Record<string, string>
  /** 自定义正文即使删掉占位符，也必须由 Builder 追加的权威上下文变量。 */
  requiredContextVariables?: readonly string[]
}

/**
 * en-US 覆盖：模型可见的字段按 writingLanguage 替换，结构字段永远沿用中文模板。
 *
 * name / description / taskGuidance 只有明确翻译过的模板才提供；其余回退中文，
 * 以保持既有行为（历史上只有 assistant_writing_identity 翻译了这三项）。
 */
export interface PromptLanguageOverlay {
  systemRole: string
  content: string
  systemSuffix?: string
  name?: string
  description?: string
  taskGuidance?: string
}

/** markdown 提示词文件里允许出现的段落名。 */
export const PROMPT_SECTION_NAMES = [
  'name',
  'description',
  'systemRole',
  'taskGuidance',
  'content',
  'systemSuffix',
] as const

export type PromptSectionName = typeof PROMPT_SECTION_NAMES[number]
