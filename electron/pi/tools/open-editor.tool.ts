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
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

const Schema = Type.Object({
  file_path: Type.String(),
  tab_type: Type.Optional(Type.String()),
})

export function createOpenEditorTool(
  language: WritingLanguage,
  rendererAction: RendererActionSink,
): AgentTool<typeof Schema> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'Open a project file in an AI Novel Writer editor tab so the user can view or edit it.'
    : '在 AI小说作家编辑器中打开指定文件的 Tab 页。用户可以直接在编辑器中查看和编辑内容。'

  return {
    name: 'open_editor',
    label: 'Open Editor',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const filePath = params.file_path
      if (!filePath) {
        throw new Error(text('缺少 file_path 参数', 'The file_path argument is required'))
      }
      const tabType = params.tab_type ?? 'chapter'

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

      const fileName = filePath.split('/').pop() ?? filePath
      rendererAction({ type: 'open_editor', filePath: fullPath, content, tabType, fileName })

      return {
        content: [{ type: 'text', text: text(
          `已在编辑器中打开：${fileName}`,
          `Opened in the editor: ${fileName}`,
        ) }],
        details: {},
      }
    },
  }
}
