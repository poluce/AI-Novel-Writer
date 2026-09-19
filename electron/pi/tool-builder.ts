
import type { WritingLanguage } from '../../src/shared/writing-language'
import type { RendererActionSink } from '../../src/shared/agent-events'
import type { AgentScope } from '../../src/shared/agent-scope'

import { createReadArchitectureTool } from './tools/read-architecture.tool'
import { createNovelConfigTool } from './tools/novel-config.tool'
import { createStoryArchitectureTool } from './tools/story-architecture.tool'
import { createReadBlueprintTool } from './tools/read-blueprint.tool'
import { createReadDraftsTool } from './tools/read-drafts.tool'
import { createReadProjectStateTool } from './tools/read-project-state.tool'
import { createSearchKnowledgeTool } from './tools/search-knowledge.tool'
import { createReadFileTool } from './tools/read-file.tool'
import { createInspectWritingSkillTool } from './tools/inspect-writing-skill.tool'
import { createLoadWritingSkillTool } from './tools/load-writing-skill.tool'
import { createInstallWritingSkillTool } from './tools/install-writing-skill.tool'
import { createBindWritingSkillTool } from './tools/bind-writing-skill.tool'
import { createOpenEditorTool } from './tools/open-editor.tool'
import { createReplaceDraftExcerptTool } from './tools/replace-draft-excerpt.tool'
import { createProposeChapterBlueprintTool } from './tools/propose-chapter-blueprint.tool'
import { createManageCharactersTool } from './tools/manage-characters.tool'
import { buildMcpAgentTools } from './tools/mcp.tool'
import type { AnyAgentTool } from './tool-types'
import type { AgentSkillCatalogEntry } from '../../src/shared/agent-skills'

/**
 * Agent 级执行是并行的，这里只把写入类与 MCP 工具钉成 sequential，
 * 让它们不会互相重叠。结果截断由 Pi 的 afterToolCall 钩子统一处理
 * （见 pi-agent.ts），不再逐个包装 execute。
 */
function withExecutionMode(tool: AnyAgentTool): AnyAgentTool {
  const sequential = confirmationToolNames().has(tool.name) || tool.name.startsWith('mcp__')
  return sequential ? { ...tool, executionMode: 'sequential' as const } : tool
}

/**
 * Build the tools one agent session may use.
 *
 * 项目助手挂全部项目工具；界面助手（没有项目时也在用）只挂不依赖项目的
 * 技能检查与 MCP——项目读写类工具在没有项目时只会失败。
 */
export function buildAgentTools(
  language: WritingLanguage,
  rendererAction: RendererActionSink,
  scope: AgentScope = 'project',
  skills: readonly AgentSkillCatalogEntry[] = [],
  skillRoots: readonly string[] = [],
): AnyAgentTool[] {
  const projectTools: AnyAgentTool[] = scope === 'project'
    ? [
      createNovelConfigTool(language, rendererAction),
      createStoryArchitectureTool(language, rendererAction),
      createReadArchitectureTool(language),
      createReadBlueprintTool(language),
      createReadDraftsTool(language),
      createReadProjectStateTool(language),
      createSearchKnowledgeTool(language),
      createReadFileTool(language),
      createInstallWritingSkillTool(language),
      createBindWritingSkillTool(language),
      createOpenEditorTool(language, rendererAction),
      createReplaceDraftExcerptTool(language, rendererAction),
      createProposeChapterBlueprintTool(language),
      createManageCharactersTool(language, rendererAction),
    ]
    : []
  return [
    ...projectTools,
    createInspectWritingSkillTool(language),
    // 渐进式披露：目录进提示词，正文由模型按需取（两个作用域都有）。
    createLoadWritingSkillTool(language, skills, skillRoots),
    ...buildMcpAgentTools(language),
  ].map(withExecutionMode)
}

/**
 * Write tools that must be confirmed by the user before execution.
 *
 * `write` / `edit` / `bash` 是 Pi harness 自带的执行工具：它们能改文件、
 * 能跑命令，所以和领域写工具一样逐次确认。
 */
export function confirmationToolNames(): ReadonlySet<string> {
  return new Set([
    'write',
    'edit',
    'bash',
    'open_editor',
    'replace_draft_excerpt',
    'novel_config',
    'story_architecture',
    'propose_chapter_blueprint',
    'manage_characters',
    'install_writing_skill',
    'bind_writing_skill',
  ])
}
