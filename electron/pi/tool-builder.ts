
import type { WritingLanguage } from '../../src/shared/writing-language'
import type { RendererActionSink } from '../../src/shared/agent-events'

import { createReadArchitectureTool } from './tools/read-architecture.tool'
import { createReadCharactersTool } from './tools/read-characters.tool'
import { createReadBlueprintTool } from './tools/read-blueprint.tool'
import { createReadDraftsTool } from './tools/read-drafts.tool'
import { createReadProjectStateTool } from './tools/read-project-state.tool'
import { createSearchKnowledgeTool } from './tools/search-knowledge.tool'
import { createReadFileTool } from './tools/read-file.tool'
import { createWriteFileTool } from './tools/write-file.tool'
import { createInspectWritingSkillTool } from './tools/inspect-writing-skill.tool'
import { createInstallWritingSkillTool } from './tools/install-writing-skill.tool'
import { createBindWritingSkillTool } from './tools/bind-writing-skill.tool'
import { createOpenEditorTool } from './tools/open-editor.tool'
import { createStartWorkflowTool } from './tools/start-workflow.tool'
import { createReplaceDraftExcerptTool } from './tools/replace-draft-excerpt.tool'
import { createProposeNovelConfigTool } from './tools/propose-novel-config.tool'
import { createProposeChapterBlueprintTool } from './tools/propose-chapter-blueprint.tool'
import { buildMcpAgentTools } from './tools/mcp.tool'
import type { AnyAgentTool } from './tool-types'

/**
 * Agent 级执行是并行的，这里只把写入类与 MCP 工具钉成 sequential，
 * 让它们不会互相重叠。结果截断由 Pi 的 afterToolCall 钩子统一处理
 * （见 pi-agent.ts），不再逐个包装 execute。
 */
function withExecutionMode(tool: AnyAgentTool): AnyAgentTool {
  const sequential = confirmationToolNames().has(tool.name) || tool.name.startsWith('mcp__')
  return sequential ? { ...tool, executionMode: 'sequential' as const } : tool
}

/** Build built-in + currently connected MCP tools for one agent session. */
export function buildAgentTools(
  language: WritingLanguage,
  rendererAction: RendererActionSink,
): AnyAgentTool[] {
  return [
    createReadArchitectureTool(language),
    createReadCharactersTool(language),
    createReadBlueprintTool(language),
    createReadDraftsTool(language),
    createReadProjectStateTool(language),
    createSearchKnowledgeTool(language),
    createReadFileTool(language),
    createWriteFileTool(language),
    createInspectWritingSkillTool(language),
    createInstallWritingSkillTool(language),
    createBindWritingSkillTool(language),
    createOpenEditorTool(language, rendererAction),
    createStartWorkflowTool(language, rendererAction),
    createReplaceDraftExcerptTool(language, rendererAction),
    createProposeNovelConfigTool(language, rendererAction),
    createProposeChapterBlueprintTool(language),
    ...buildMcpAgentTools(language),
  ].map(withExecutionMode)
}

/** Write tools that must be confirmed by the user before execution. */
export function confirmationToolNames(): ReadonlySet<string> {
  return new Set([
    'write_file',
    'open_editor',
    'start_workflow',
    'replace_draft_excerpt',
    'propose_novel_config',
    'propose_chapter_blueprint',
    'install_writing_skill',
    'bind_writing_skill',
  ])
}
