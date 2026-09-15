/**
 * 技能目录的线上形态（主进程 → 渲染层）。
 *
 * 主进程用 Pi 的加载器扫描目录（YAML frontmatter、忽略文件、规范校验），
 * 应用扩展字段与写作技能兼容性由 `inspectWritingSkillMarkdown` 补齐；
 * 这里只声明两端共用的结构。
 */

import type {
  WritingSkillCompatibilityReason,
  WritingSkillLanguage,
  WritingSkillStage,
} from './writing-skills'

export type WritingSkillCatalogSource = 'user' | 'project'

export interface WritingSkillCatalogRecord {
  name: string
  description: string
  /** SKILL.md 正文（已去掉 frontmatter）。 */
  content: string
  /** SKILL.md 绝对路径。 */
  filePath: string
  /** 技能目录；技能包内的相对引用以它为基准。 */
  baseDir: string
  source: WritingSkillCatalogSource
  /** frontmatter `disable-model-invocation`：为真时不进模型可见清单。 */
  disableModelInvocation?: boolean
  displayName?: string
  version?: string
  language: WritingSkillLanguage
  stage?: WritingSkillStage
  /** 本应用的产品约束（ADR 0015）：只收自包含提示词技能。 */
  compatible: boolean
  reasons: readonly WritingSkillCompatibilityReason[]
  suggestedStage: WritingSkillStage
  utf8Bytes: number
}

export interface WritingSkillCatalogDiagnostic {
  code: string
  message: string
  path: string
  source?: WritingSkillCatalogSource
}

export interface WritingSkillCatalog {
  skills: WritingSkillCatalogRecord[]
  diagnostics: WritingSkillCatalogDiagnostic[]
}
