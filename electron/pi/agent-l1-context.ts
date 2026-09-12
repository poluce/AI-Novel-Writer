import type { AgentEditorSnapshot } from '../../src/shared/agent-events'
import { writingLanguageText, type WritingLanguage } from '../../src/shared/writing-language'

const ACTIVE_PREVIEW_LIMIT = 500

/**
 * Format the renderer L1 snapshot as an ephemeral user message.
 * Tool catalogs stay on AgentTool schemas — this is app-shell awareness.
 */
export function buildL1AgentContext(
  snapshot: AgentEditorSnapshot | null | undefined,
  language: WritingLanguage,
): string | null {
  if (!snapshot) return null
  const label = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const parts: string[] = []

  parts.push(`## ${label('应用状态', 'App state')}`)
  if (snapshot.project?.open) {
    parts.push(label(
      `当前小说项目：已打开「${snapshot.project.name ?? snapshot.project.path ?? ''}」`,
      `Current novel project: open "${snapshot.project.name ?? snapshot.project.path ?? ''}"`,
    ))
  } else {
    parts.push(label(
      '当前小说项目：未打开。读写项目工具会失败，除非用户先打开一本书。',
      'Current novel project: none open. Project read/write tools will fail until the user opens a book.',
    ))
  }

  if (snapshot.recentProjects && snapshot.recentProjects.length > 0) {
    const names = snapshot.recentProjects.map(item => item.name).join('、')
    parts.push(`${label('最近项目', 'Recent projects')}: ${names}`)
  }

  if (snapshot.layout) {
    const layout = snapshot.layout
    const sidebar = labelSidebar(layout.sidebarView, language)
    const right = layout.rightView === 'ai-output'
      ? label('AI 输出', 'AI output')
      : label('助手对话', 'assistant chat')
    const bottom = layout.bottomPanelOpen
      ? `${label('已打开', 'open')} (${layout.bottomTab})`
      : label('关闭', 'closed')
    const dialogs: string[] = []
    if (layout.settingsOpen) dialogs.push(label('设置', 'settings'))
    if (layout.newProjectOpen) dialogs.push(label('新建项目', 'new project'))
    if (layout.importNovelOpen) dialogs.push(label('导入小说', 'import novel'))
    if (layout.chapterCreationOpen) dialogs.push(label('创建章节', 'create chapter'))
    parts.push(
      `${label('左侧栏', 'Sidebar')}: ${sidebar}`,
      `${label('右侧栏', 'Right panel')}: ${right}`,
      `${label('底部面板', 'Bottom panel')}: ${bottom}`,
    )
    if (dialogs.length > 0) {
      parts.push(`${label('打开的对话框', 'Open dialogs')}: ${dialogs.join('、')}`)
    }
  }

  if (snapshot.mcp) {
    parts.push(label(
      `MCP：已连接 ${snapshot.mcp.connectedServers} 个服务器，${snapshot.mcp.tools} 个工具`,
      `MCP: ${snapshot.mcp.connectedServers} connected server(s), ${snapshot.mcp.tools} tool(s)`,
    ))
  }

  if (snapshot.changes && snapshot.changes.length > 0) {
    const lines = snapshot.changes.map(change => `  - ${change.kind}: ${change.from} → ${change.to}`)
    parts.push(`${label('自上一轮以来的界面变更', 'UI changes since the last turn')}:\n${lines.join('\n')}`)
  }

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

function labelSidebar(view: string, language: WritingLanguage): string {
  const map: Record<string, [string, string]> = {
    home: ['主页', 'home'],
    project: ['项目', 'project'],
    knowledge: ['知识库', 'knowledge'],
    characters: ['角色', 'characters'],
    settings: ['设置', 'settings'],
  }
  const pair = map[view]
  return pair ? writingLanguageText(language, pair[0], pair[1]) : view
}
