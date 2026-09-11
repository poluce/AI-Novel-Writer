import type { AgentEditorSnapshot } from '../../src/shared/agent-events'
import { writingLanguageText, type WritingLanguage } from '../../src/shared/writing-language'

const ACTIVE_PREVIEW_LIMIT = 500

/**
 * Format the renderer L1 snapshot as an ephemeral user message.
 * Tool catalogs stay on AgentTool schemas — this is editor/workflow awareness only.
 */
export function buildL1AgentContext(
  snapshot: AgentEditorSnapshot | null | undefined,
  language: WritingLanguage,
): string | null {
  if (!snapshot) return null
  const label = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const parts: string[] = []

  if (snapshot.tabs.length > 0) {
    const tabSummaries = snapshot.tabs.map(tab => {
      const active = tab.active ? ` [${label('当前活跃', 'active')}]` : ''
      const dirty = tab.unsaved ? ` [${label('未保存', 'unsaved')}]` : ''
      return `  - ${tab.name} (${tab.type})${active}${dirty}`
    }).join('\n')
    parts.push(`## ${label('编辑器状态', 'Editor state')}\n${label('打开的文件', 'Open files')}:\n${tabSummaries}`)

    const activeTab = snapshot.tabs.find(tab => tab.active)
    if (activeTab?.preview) {
      const preview = activeTab.preview.length > ACTIVE_PREVIEW_LIMIT
        ? `${activeTab.preview.slice(0, ACTIVE_PREVIEW_LIMIT)}\n${label('…（内容过长已截断，可通过 read_file 工具获取完整内容）', '... (preview truncated; use read_file to retrieve the complete content)')}`
        : activeTab.preview
      parts.push(`### ${label('当前活跃文件内容', 'Active file content')}\n${label('文件名', 'File')}: ${activeTab.name}\n\`\`\`\n${preview}\n\`\`\``)
    }
  }

  if (snapshot.workflow) {
    const runName = language === 'en-US' ? snapshot.workflow.type : snapshot.workflow.title
    parts.push(
      `## ${label('工作流状态', 'Workflow status')}\n${label('正在运行', 'Running')}: ${runName} (${label('进度', 'progress')}: ${snapshot.workflow.currentStepIndex + 1}/${snapshot.workflow.stepCount})`,
    )
  }

  return parts.length > 0 ? parts.join('\n\n') : null
}
