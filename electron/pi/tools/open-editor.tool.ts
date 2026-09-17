import path from 'node:path'

import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { getCurrentProjectPath } from '../../database'
import { assertProjectFilePath } from '../../utils/project-context'
import {
  createSecureFileCapability,
  windowsSafeFileSystem,
} from '../../security/windows-safe-file-system'
import type { RendererActionSink } from '../renderer-action'
import type { BuiltinEditorTarget } from '../../../src/shared/agent-events'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

/**
 * 数据库驱动的内置页面不需要文件路径；只有 file 目标才读取物理文件。
 * 内置页面的打开由渲染层完成，主进程不做多余的读盘。
 */
const TARGET_ALIASES: Record<string, BuiltinEditorTarget | 'file'> = {
  config: 'config',
  blueprints: 'blueprints',
  characters: 'characters',
  architecture: 'architecture',
  synopsis: 'synopsis',
  file: 'file',
  '小说配置': 'config',
  '配置': 'config',
  '章节蓝图': 'blueprints',
  '蓝图': 'blueprints',
  '角色管理': 'characters',
  '角色': 'characters',
  '人物': 'characters',
  '故事架构': 'architecture',
  '架构': 'architecture',
  '情节大纲': 'synopsis',
  '大纲': 'synopsis',
  '文件': 'file',
}

const Target = Type.Union([
  Type.Literal('config', { description: '小说配置页面（基础参数、受众、核心大纲、金手指等）' }),
  Type.Literal('blueprints', { description: '章节蓝图页面（全书章节规划细纲清单）' }),
  Type.Literal('characters', { description: '角色管理页面（全书角色档案与关系图谱）' }),
  Type.Literal('architecture', { description: '故事架构页面（故事前提、世界观设定）' }),
  Type.Literal('synopsis', { description: '情节大纲页面（全书分卷情节大纲）' }),
  Type.Literal('file', { description: '以只读方式查看项目物理文本文件（需提供 file_path）' }),
], { description: '要打开的目标编辑器或页面类型' })

const Schema = Type.Object({
  target: Target,
  file_path: Type.Optional(Type.String({ description: '当 target 为 "file" 时必填，指定项目目录内文本文件的相对路径' })),
})

const TARGET_LABELS: Record<BuiltinEditorTarget, readonly [string, string]> = {
  config: ['小说配置', 'Novel configuration'],
  blueprints: ['章节蓝图', 'Chapter blueprints'],
  characters: ['角色管理', 'Characters'],
  architecture: ['故事架构', 'Story architecture'],
  synopsis: ['情节大纲', 'Plot outline'],
}

export function createOpenEditorTool(
  language: WritingLanguage,
  rendererAction: RendererActionSink,
): AgentTool<typeof Schema> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'Open a page for the user: a built-in database-backed editor (config, blueprints, characters, architecture, synopsis) or a read-only view of a project file (target "file" requires file_path).'
    : '为用户打开页面：数据库驱动的内置编辑器（小说配置 config、章节蓝图 blueprints、角色管理 characters、故事架构 architecture、情节大纲 synopsis），或以只读视图打开项目内的文件（target 用 file，需给 file_path）。'

  return {
    name: 'open_editor',
    label: 'Open Editor',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const rawTarget = params.target
      const target = TARGET_ALIASES[rawTarget] ?? (rawTarget as BuiltinEditorTarget | 'file')

      if (target !== 'file') {
        const label = TARGET_LABELS[target]
        rendererAction({ type: 'open_editor', target: 'builtin', editor: target })
        return {
          content: [{ type: 'text', text: text(
            `已打开「${label[0]}」页面`,
            `Opened the ${label[1]} page`,
          ) }],
          details: { name: text(label[0], label[1]), editor: target },
        }
      }

      const filePath = params.file_path
      if (!filePath) {
        throw new Error(text('target=file 时必须提供 file_path', 'file_path is required when target is "file"'))
      }

      const projectPath = getCurrentProjectPath()
      if (!projectPath) {
        throw new Error(text('未打开项目', 'No project is open'))
      }

      const fullPath = path.resolve(projectPath, filePath)
      try {
        assertProjectFilePath(fullPath, projectPath, 'existing')
      } catch {
        throw new Error(text(
          `路径越界：「${filePath}」超出了项目目录范围。只能访问项目内的文件。`,
          `The path "${filePath}" is outside the project directory. Only project files can be opened.`,
        ))
      }

      let content: string
      try {
        const capability = createSecureFileCapability(projectPath, fullPath)
        content = await windowsSafeFileSystem.readText(capability)
      } catch {
        throw new Error(text('文件读取失败', 'Could not read the file'))
      }

      const fileName = filePath.split(/[\\/]/).pop() ?? filePath
      rendererAction({ type: 'open_editor', target: 'file', filePath: fullPath, content, fileName })

      return {
        content: [{ type: 'text', text: text(
          `已在编辑器中打开：${fileName}`,
          `Opened in the editor: ${fileName}`,
        ) }],
        details: { name: fileName, path: fullPath },
      }
    },
  }
}
