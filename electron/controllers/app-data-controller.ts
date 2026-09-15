import fs from 'node:fs'
import path from 'node:path'
import { app, ipcMain } from 'electron'
import type { AppPromptLoadReceipt, AppPromptTemplate } from '../../src/shared/ipc-channels'
import type { WritingLanguage } from '../../src/shared/writing-language'
import { mainText } from '../i18n'
import { VELA_HOME, writeJsonFile } from '../utils/config-utils'
import { appendVelaLog } from '../utils/app-log'
import type { DiagnosticLogRecord } from '../../src/shared/fail-log'
import { inspectWritingSkill, installWritingSkill } from '../services/writing-skill-service'
import { loadWritingSkillCatalog, projectSkillsRoot } from '../services/writing-skill-catalog'
import type { ProjectSessionContext } from '../../src/shared/ipc-channels'
import { projectAccess } from '../services/project-access'
import { getCurrentProjectPath } from '../database'
import {
  assertProjectFilePath,
  assertRequiredExpectedProjectPath,
} from '../utils/project-context'

function text(zhCNText: string, enUSText: string): string {
  return mainText(app.getLocale(), zhCNText, enUSText)
}

function isContainedPath(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath)
  return !(
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  )
}

function promptKeyPath(key: string, writingLanguage?: WritingLanguage): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)
    || key === '.'
    || key === '..'
  ) {
    throw new Error(text('提示词标识无效', 'The prompt identifier is invalid'))
  }
  const promptsDirectory = path.join(VELA_HOME, 'prompts')
  const suffix = writingLanguage ? `.${writingLanguage}` : ''
  const candidatePath = path.resolve(promptsDirectory, `${key}${suffix}.json`)
  if (!isContainedPath(promptsDirectory, candidatePath)) {
    throw new Error(text('提示词目标超出应用目录', 'The prompt target is outside the app directory'))
  }
  return candidatePath
}

function isPromptTemplate(value: unknown): value is AppPromptTemplate {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as AppPromptTemplate).key === 'string'
    && (
      (value as AppPromptTemplate).writingLanguage === undefined
      || (value as AppPromptTemplate).writingLanguage === 'zh-CN'
      || (value as AppPromptTemplate).writingLanguage === 'en-US'
    )
}

const WRITING_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function writingSkillDirectory(name: string): string {
  if (!WRITING_SKILL_NAME.test(name) || name === '.' || name === '..') {
    throw new Error(text('写作 Skill 名称无效', 'The writing skill name is invalid'))
  }
  const root = path.join(VELA_HOME, 'skills')
  const candidate = path.resolve(root, name)
  if (!isContainedPath(root, candidate)) {
    throw new Error(text('写作 Skill 目标超出应用目录', 'The writing skill target is outside the app directory'))
  }
  return candidate
}

function ensureOwnedSkillsRoot(): string {
  if (fs.existsSync(VELA_HOME)) {
    const homeInfo = fs.lstatSync(VELA_HOME)
    if (homeInfo.isSymbolicLink() || !homeInfo.isDirectory()) {
      throw new Error(text('应用数据目录不是受信任的本地目录', 'The app data root is not a trusted local directory'))
    }
  } else {
    fs.mkdirSync(VELA_HOME, { recursive: true })
  }
  const canonicalVelaHome = fs.realpathSync.native(VELA_HOME)
  const skillsRoot = path.join(VELA_HOME, 'skills')
  if (fs.existsSync(skillsRoot)) {
    const rootInfo = fs.lstatSync(skillsRoot)
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new Error(text('用户 Skill 目录不是受信任的本地目录', 'The user skill root is not a trusted local directory'))
    }
  } else {
    fs.mkdirSync(skillsRoot)
  }
  const canonicalRoot = fs.realpathSync.native(skillsRoot)
  if (!isContainedPath(canonicalVelaHome, canonicalRoot)) {
    throw new Error(text('用户 Skill 目录超出应用目录', 'The user skill root is outside the app directory'))
  }
  return canonicalRoot
}

function promptFilename(template: AppPromptTemplate): string {
  return `${template.key}${template.writingLanguage ? `.${template.writingLanguage}` : ''}`
}

function promptKeyFromFilename(filename: string): string {
  return path.basename(filename, '.json').replace(/\.(?:zh-CN|en-US)$/u, '')
}

function promptLanguageFromFilename(filename: string): WritingLanguage | undefined {
  const match = filename.match(/\.(zh-CN|en-US)\.json$/u)
  return match?.[1] as WritingLanguage | undefined
}

/**
 * ~/.vela 的提示词和用户 Skill 只能由此固定根目录控制器访问；渲染层不接收
 * 任意 app-data 路径，也不借用外部文件授权。
 */
export function registerAppDataController(): void {
  ipcMain.handle('app:append-diagnostic-log', (_event, record: DiagnosticLogRecord) => {
    if (!record || typeof record !== 'object' || typeof record.scope !== 'string' || typeof record.event !== 'string') {
      return { success: false }
    }
    appendVelaLog(record)
    return { success: true }
  })

  ipcMain.handle('prompt:load-global', async (): Promise<AppPromptLoadReceipt> => {
    const promptsDirectory = path.join(VELA_HOME, 'prompts')
    if (!fs.existsSync(promptsDirectory)) return { templates: [], diagnostics: [] }

    const prompts: AppPromptTemplate[] = []
    const diagnostics: AppPromptLoadReceipt['diagnostics'] = []
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(promptsDirectory, { withFileTypes: true })
    } catch (error) {
      return {
        templates: [],
        diagnostics: [{
          path: 'prompts',
          error: error instanceof Error ? error.message : String(error),
        }],
      }
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      try {
        const candidatePath = path.join(promptsDirectory, entry.name)
        const canonicalPath = fs.realpathSync.native(candidatePath)
        if (!isContainedPath(fs.realpathSync.native(promptsDirectory), canonicalPath)) continue
        const parsed = JSON.parse(fs.readFileSync(canonicalPath, 'utf8')) as unknown
        if (!isPromptTemplate(parsed)) {
          throw new Error(text('提示词内容结构无效', 'The prompt content shape is invalid'))
        }
        const filenameKey = path.basename(entry.name, '.json')
        if (promptFilename(parsed) !== filenameKey) {
          throw new Error(text('提示词标识或语言与文件名不一致', 'The prompt identifier or language does not match its filename'))
        }
        prompts.push(parsed)
      } catch (error) {
        diagnostics.push({
          key: promptKeyFromFilename(entry.name),
          ...(promptLanguageFromFilename(entry.name)
            ? { writingLanguage: promptLanguageFromFilename(entry.name) }
            : {}),
          path: entry.name,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { templates: prompts, diagnostics }
  })

  ipcMain.handle('prompt:save-global', async (_event, template: AppPromptTemplate) => {
    try {
      if (!isPromptTemplate(template)) {
        throw new Error(text('提示词内容无效', 'The prompt content is invalid'))
      }
      const writingLanguage = template.writingLanguage ?? 'zh-CN'
      writeJsonFile(promptKeyPath(template.key, writingLanguage), { ...template, writingLanguage })
      if (writingLanguage === 'zh-CN') {
        const legacyPath = promptKeyPath(template.key)
        if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath)
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('prompt:delete-global', async (_event, key: string, writingLanguage: WritingLanguage) => {
    try {
      const filePaths = [promptKeyPath(key, writingLanguage)]
      if (writingLanguage === 'zh-CN') filePaths.push(promptKeyPath(key))
      for (const filePath of filePaths) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  /**
   * 技能目录：用户级 + 当前项目级。
   *
   * 带项目时必须先以当前租约认证项目身份，并把技能根钉在项目内；不带项目
   * （界面助手/启动早期）只读应用数据目录下的用户技能。扫描本身交给 Pi 的
   * 加载器，规范诊断随目录一起返回，渲染层据此提示而不是静默跳过。
   */
  ipcMain.handle('skills:load-user-catalog', async () => {
    return loadWritingSkillCatalog({ projectPath: null })
  })

  ipcMain.handle('skills:load-catalog', async (
    _event,
    expectedProjectPath: string,
    context: ProjectSessionContext,
  ) => {
    const active = projectAccess.assertCurrentProjectContext(context, getCurrentProjectPath())
    assertRequiredExpectedProjectPath(active.rootPath, expectedProjectPath)
    const skillsRoot = projectSkillsRoot(expectedProjectPath)
    assertProjectFilePath(skillsRoot, active.rootPath, 'writable')
    return loadWritingSkillCatalog({ projectPath: expectedProjectPath })
  })

  ipcMain.handle('skills:inspect-github', async (_event, sourceUrl: string) => {
    return inspectWritingSkill(sourceUrl)
  })

  ipcMain.handle('skills:install-github', async (_event, sourceUrl: string) => {
    return installWritingSkill(sourceUrl)
  })

  ipcMain.handle('skills:uninstall-user', async (_event, name: string) => {
    try {
      const directory = writingSkillDirectory(name)
      const skillsRoot = path.join(VELA_HOME, 'skills')
      if (!fs.existsSync(skillsRoot)) return { success: true }
      const canonicalRoot = ensureOwnedSkillsRoot()
      if (!fs.existsSync(directory)) return { success: true }
      if (fs.lstatSync(directory).isSymbolicLink()) {
        throw new Error(text('拒绝删除符号链接 Skill', 'Refusing to delete a symlinked skill'))
      }
      const canonicalDirectory = fs.realpathSync.native(directory)
      if (!isContainedPath(canonicalRoot, canonicalDirectory)) {
        throw new Error(text('写作 Skill 目标超出应用目录', 'The writing skill target is outside the app directory'))
      }
      fs.rmSync(canonicalDirectory, { recursive: true, force: false })
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
