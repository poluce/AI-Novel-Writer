import path from 'node:path'

import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { getCurrentProjectPath } from '../../database'
import { assertProjectFilePath } from '../../utils/project-context'
import {
  createSecureFileCapability,
  windowsSafeFileSystem,
} from '../../security/windows-safe-file-system'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'
import { logFailure } from '../../../src/shared/fail-log'

const Schema = Type.Object({
  file_path: Type.String(),
})

export function createReadFileTool(
  language: WritingLanguage,
): AgentTool<typeof Schema> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'Read an existing text file in the project directory. Use read_architecture for story architecture stored in project data instead of assuming an architecture file path.'
    : '读取项目目录中实际存在的文本文件。故事架构保存在项目数据中，请使用 read_architecture 工具读取，不要假定存在架构文件路径。'

  return {
    name: 'read_file',
    label: 'Read File',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const filePath = params.file_path
      if (!filePath) {
        throw new Error(text('缺少文件路径参数', 'The file path argument is required'))
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
          `The path "${filePath}" is outside the project directory. Only project files can be read.`,
        ))
      }

      try {
        const capability = createSecureFileCapability(projectPath, fullPath)
        const content = await windowsSafeFileSystem.readText(capability)
        return { content: [{ type: 'text', text: content }], details: {} }
      } catch (error) {
        logFailure('AgentTool', 'read_file failed', error, { filePath })
        throw new Error(text('文件读取失败', 'Could not read the file'))
      }
    },
  }
}
