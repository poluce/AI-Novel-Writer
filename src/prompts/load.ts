/**
 * 内置提示词加载器。
 *
 * 提示词正文存放在 ./zh-CN/*.md 与 ./en-US/*.md（人工编辑的唯一来源）。
 * `scripts/generate-prompt-modules.mjs` 把它们编译成 ./generated/*.ts 的纯字符串
 * 模块——等价于 Qt 的 rcc 把 .qrc 编译成代码：
 *   - 运行时零文件系统依赖，打包后随 bundle 走；
 *   - 生成的模块是普通 TS，Vite 与 esbuild（发布资格/校准脚本）都能打包。
 * 不要直接用 import.meta.glob：那是 Vite 专有 API，esbuild 打包的产品代码会崩。
 *
 * 文件格式契约（与生成 md 的脚本一致）：
 *
 *   <!-- section:NAME -->\n + 原文 + \n\n
 *
 * 加载时只剥掉作为分隔符的那一个空行，原文自带的换行逐字节保留。
 */
import { BUILTIN_PROMPT_STRUCTURES } from './manifest'
import { ZH_CN_PARSED_PROMPTS, ZH_CN_PROMPT_SOURCES } from './generated/zh-CN'
import { EN_US_PARSED_PROMPTS, EN_US_PROMPT_SOURCES } from './generated/en-US'
import type { PromptLanguageOverlay, PromptTemplate, PromptSectionName } from './types'
import { PROMPT_SECTION_NAMES } from './types'

const SECTION_PATTERN = /<!--\s*section:([A-Za-z]+)\s*-->\n/g
const SECTION_NAME_SET = new Set<string>(PROMPT_SECTION_NAMES)

const zhByKey: Readonly<Record<string, string>> = ZH_CN_PROMPT_SOURCES
const enByKey: Readonly<Record<string, string>> = EN_US_PROMPT_SOURCES

/**
 * 解析一份提示词 markdown 的所有段落。
 *
 * 未知段落名直接报错：拼错 `section:` 会让提示词静默缺字段，必须显式失败。
 */
export function parsePromptSections(source: string): Partial<Record<PromptSectionName, string>> {
  const sections: Partial<Record<PromptSectionName, string>> = {}
  const matches = [...source.matchAll(SECTION_PATTERN)]
  for (const [index, match] of matches.entries()) {
    const name = match[1]
    if (!SECTION_NAME_SET.has(name)) {
      throw new Error(`Unknown prompt section: ${name}`)
    }
    const start = (match.index ?? 0) + match[0].length
    const next = matches[index + 1]
    const end = next?.index ?? source.length
    let body = source.slice(start, end)
    // 写入端的固定分隔符；手改文件漏掉空行时容忍只剥一个换行。
    if (body.endsWith('\n\n')) body = body.slice(0, -2)
    else if (body.endsWith('\n')) body = body.slice(0, -1)
    sections[name as PromptSectionName] = body
  }
  return sections
}

function requireSection(
  sections: Partial<Record<PromptSectionName, string>>,
  key: string,
  section: PromptSectionName,
): string {
  const value = sections[section]
  if (value === undefined) {
    throw new Error(`Prompt ${key} is missing the "${section}" section`)
  }
  return value
}

function readTemplate(structure: (typeof BUILTIN_PROMPT_STRUCTURES)[number]): PromptTemplate {
  const sections = ZH_CN_PARSED_PROMPTS[structure.key] ?? (zhByKey[structure.key] ? parsePromptSections(zhByKey[structure.key]) : undefined)
  if (sections === undefined) {
    throw new Error(`Missing zh-CN prompt source for ${structure.key}`)
  }
  const template: PromptTemplate = {
    key: structure.key,
    name: requireSection(sections, structure.key, 'name'),
    description: requireSection(sections, structure.key, 'description'),
    content: requireSection(sections, structure.key, 'content'),
    variables: { ...structure.variables },
  }
  if (sections.systemRole !== undefined) template.systemRole = sections.systemRole
  if (sections.systemSuffix !== undefined) template.systemSuffix = sections.systemSuffix
  if (sections.taskGuidance !== undefined) template.taskGuidance = sections.taskGuidance
  if (structure.requiredContextVariables) {
    template.requiredContextVariables = [...structure.requiredContextVariables]
  }
  return template
}

/** 内置模板（中文正文），顺序与 manifest 一致。编译期预解析，零运行时正则开销。 */
export const BUILTIN_PROMPTS: PromptTemplate[] = BUILTIN_PROMPT_STRUCTURES.map(readTemplate)

function readOverlay(key: string): PromptLanguageOverlay | undefined {
  const sections = EN_US_PARSED_PROMPTS[key] ?? (enByKey[key] ? parsePromptSections(enByKey[key]) : undefined)
  if (sections === undefined) return undefined
  const overlay: PromptLanguageOverlay = {
    systemRole: requireSection(sections, key, 'systemRole'),
    content: requireSection(sections, key, 'content'),
  }
  if (sections.systemSuffix !== undefined) overlay.systemSuffix = sections.systemSuffix
  if (sections.name !== undefined) overlay.name = sections.name
  if (sections.description !== undefined) overlay.description = sections.description
  if (sections.taskGuidance !== undefined) overlay.taskGuidance = sections.taskGuidance
  return overlay
}

/** 英文覆盖；只有 ./en-US 下存在同名文件时才提供。 */
export const EN_US_BUILTIN_PROMPTS: Readonly<Record<string, PromptLanguageOverlay>> =
  Object.freeze(Object.fromEntries(
    Object.keys(enByKey).sort().flatMap(key => {
      const overlay = readOverlay(key)
      return overlay ? [[key, overlay] as const] : []
    }),
  ))
