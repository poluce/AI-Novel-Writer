/**
 * 内部提示词加载器。
 *
 * 与 `./load.ts`（面向作者的、可在设置中覆盖的内置模板）不同，这里的提示词是
 * 工作流内部的模型合同与续写指令：作者不编辑它们，也不进入 prompt 目录与覆盖机制。
 *
 * 正文仍在 markdown（`./internal/<language>/<key>.md`），由
 * `scripts/generate-prompt-modules.mjs` 编译成 `./generated/internal-*.ts`，
 * 因此运行时零文件依赖，且 Vite 与 esbuild 都能打包。
 *
 * 插值使用 `{{name}}` 占位符；缺失的变量按空字符串替换（与既有字符串模板一致，
 * 那些模板在缺值时也会渲染出空行）。
 */
import { EN_US_INTERNAL_PROMPT_SOURCES } from '../generated/internal-en-US'
import { ZH_CN_INTERNAL_PROMPT_SOURCES } from '../generated/internal-zh-CN'
import { SHARED_INTERNAL_PROMPT_SOURCES } from '../generated/internal-shared'
import { resolveWritingLanguage, type WritingLanguage } from '../../shared/writing-language'

const SOURCES: Readonly<Record<WritingLanguage, Readonly<Record<string, string>>>> = Object.freeze({
  'zh-CN': ZH_CN_INTERNAL_PROMPT_SOURCES,
  'en-US': EN_US_INTERNAL_PROMPT_SOURCES,
})

const PLACEHOLDER = /\{\{([a-zA-Z0-9_]+)\}\}/g

export type InternalPromptVariables = Readonly<Record<string, string | number>>

/**
 * 取一条内部提示词并完成插值；key 不存在时立即失败，避免静默发出空提示词。
 *
 * `shared/` 下的 key 与写作语言无关（历史上这些合同只有中文一种文本，
 * 中英文项目都使用它），查找时优先语言目录，再回退 shared。
 */
export function internalPrompt(
  key: string,
  language: WritingLanguage,
  variables: InternalPromptVariables = {},
): string {
  const source = SOURCES[resolveWritingLanguage(language)][key]
    ?? SHARED_INTERNAL_PROMPT_SOURCES[key]
  if (source === undefined) {
    throw new Error(`Unknown internal prompt: ${key}`)
  }
  return source.replace(PLACEHOLDER, (_match, name: string) => {
    const value = variables[name]
    return value === undefined ? '' : String(value)
  })
}

/**
 * 取一条与写作语言无关的内部提示词（`shared/` 目录）。
 *
 * 这些合同历史上只有中文一种文本，中英文项目共用，因此不接收 language。
 */
export function sharedInternalPrompt(
  key: string,
  variables: InternalPromptVariables = {},
): string {
  const source = SHARED_INTERNAL_PROMPT_SOURCES[key]
  if (source === undefined) {
    throw new Error(`Unknown shared internal prompt: ${key}`)
  }
  return source.replace(PLACEHOLDER, (_match, name: string) => {
    const value = variables[name]
    return value === undefined ? '' : String(value)
  })
}
