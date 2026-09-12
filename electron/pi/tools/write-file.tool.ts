import path from 'node:path'

import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { getCurrentProjectPath } from '../../database'
import { assertProjectFilePath } from '../../utils/project-context'
import {
  atomicWriteFailureCommitState,
  createSecureFileCapability,
  windowsSafeFileSystem,
  type SecureFileCapability,
} from '../../security/windows-safe-file-system'
import { projectFactWorkflowForFilePath } from '../../../src/services/project-fact-targets'
import type { FileWriteCommitState } from '../../../src/shared/ipc-channels'
import { logFailure } from '../../../src/shared/fail-log'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

const Schema = Type.Object({
  file_path: Type.String(),
  content: Type.String(),
})

function parentCapability(capability: SecureFileCapability): SecureFileCapability {
  const parent = path.win32.dirname(capability.relativePath)
  return {
    rootPath: capability.rootPath,
    relativePath: parent === '.' ? '' : parent,
    rootIdentity: capability.rootIdentity,
  }
}

export function createWriteFileTool(
  language: WritingLanguage,
): AgentTool<typeof Schema, { path: string; characters: number; commitState: FileWriteCommitState }> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'Create or overwrite a file in the project after user confirmation.'
    : '写入或修改项目内的文件。可用于创建新文件或覆盖已有文件内容。这是一个写入操作，需要用户确认。'

  return {
    name: 'write_file',
    label: 'Write File',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const filePath = params.file_path
      const content = params.content
      if (!filePath || content === undefined) {
        throw new Error(text('缺少 file_path 或 content 参数', 'The file_path and content arguments are required'))
      }

      const reservedWorkflow = projectFactWorkflowForFilePath(filePath)
      if (reservedWorkflow) {
        throw new Error(text(
          `“${filePath}”是项目事实的保留语义目标；普通文件不会改变结构化项目。请改用 ${reservedWorkflow} 工作流。`,
          `"${filePath}" is reserved for structured project facts. Writing a plain file will not update the project; use the ${reservedWorkflow} workflow instead.`,
        ))
      }

      const projectPath = getCurrentProjectPath()
      if (!projectPath) {
        throw new Error(text('未打开项目', 'No project is open'))
      }

      const fullPath = path.resolve(projectPath, filePath)
      try {
        assertProjectFilePath(fullPath, projectPath, 'writable')
      } catch {
        throw new Error(text(
          `路径越界：「${filePath}」超出了项目目录范围。只能访问项目内的文件。`,
          `The path "${filePath}" is outside the project directory. Only project files can be written.`,
        ))
      }

      try {
        const capability = createSecureFileCapability(projectPath, fullPath)
        await windowsSafeFileSystem.mkdir(parentCapability(capability))
        await windowsSafeFileSystem.writeTextAtomically(capability, content)
      } catch (error) {
        const commitState = atomicWriteFailureCommitState(error) ?? 'not_committed'
        logFailure('AgentTool', 'write_file failed', error, { filePath, commitState })
        if (commitState === 'unknown') {
          return {
            content: [{ type: 'text', text: text(
              '写入结果未知：文件可能已写入，请勿自动重试。',
              'Write result is unknown: the file may already have been written. Do not retry automatically.',
            ) }],
            details: { path: fullPath, characters: content.length, commitState },
          }
        }
        throw new Error(text('写入失败', 'Could not write the file'))
      }

      return {
        content: [{ type: 'text', text: text(
          `✅ 文件已写入：${filePath}（${content.length} 字符）`,
          `✅ File written: ${filePath} (${content.length} characters)`,
        ) }],
        details: { path: fullPath, characters: content.length, commitState: 'committed' as const },
      }
    },
  }
}
