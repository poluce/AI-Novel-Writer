
import type { WritingLanguage } from '../../src/shared/writing-language'
import type { RendererActionSink } from '../../src/shared/agent-events'

import { createReadArchitectureTool } from './tools/read-architecture.tool'
import { createNovelConfigTool } from './tools/novel-config.tool'
import { createStoryArchitectureTool } from './tools/story-architecture.tool'
import { createReadBlueprintTool } from './tools/read-blueprint.tool'
import { createManageDraftsTool } from './tools/manage-drafts.tool'
import { createReadProjectStateTool } from './tools/read-project-state.tool'
import { createSearchKnowledgeTool } from './tools/search-knowledge.tool'
import { createManageKnowledgeBaseTool } from './tools/manage-knowledge-base.tool'
import { createReadFileTool } from './tools/read-file.tool'
import { createManageSkillsTool } from './tools/manage-skills.tool'
import { createOpenEditorTool } from './tools/open-editor.tool'
import { createProposeChapterBlueprintTool } from './tools/propose-chapter-blueprint.tool'
import { createManageCharactersTool } from './tools/manage-characters.tool'
import { createManageMcpTool } from './tools/manage-mcp.tool'
import { createWebFetchTool } from './tools/web-fetch.tool'
import { buildMcpAgentTools } from './tools/mcp.tool'
import type { AnyAgentTool } from './tool-types'
import type { AgentSkillCatalogEntry } from '../../src/shared/agent-skills'

/**
 * 需要串行执行的工具名单（写操作、环境变动与命令执行）。
 * 其它纯只读工具默认并行执行。
 */
export function sequentialToolNames(): ReadonlySet<string> {
  return new Set([
    'write',
    'edit',
    'bash',
    'open_editor',
    'manage_drafts',
    'novel_config',
    'story_architecture',
    'propose_chapter_blueprint',
    'manage_characters',
    'manage_mcp',
    'manage_skills',
    'manage_knowledge_base',
  ])
}

/**
 * Agent 级执行是并行的，这里只把写入类与 MCP 工具钉成 sequential，
 * 让它们不会互相重叠。结果截断由 Pi 的 afterToolCall 钩子统一处理
 * （见 pi-agent.ts），不再逐个包装 execute。
 */
export function withExecutionMode<T extends { name: string; executionMode?: 'sequential' | 'parallel' }>(tool: T): T {
  const sequential = sequentialToolNames().has(tool.name) || tool.name.startsWith('mcp__')
  return sequential ? { ...tool, executionMode: 'sequential' as const } : tool
}

/**
 * Build the tools one agent session may use.
 *
 * 助手只存在于项目内，因此始终挂完整的项目工具集；技能检查与 MCP
 * 不依赖项目，与项目工具一起装配。
 */
export function buildAgentTools(
  language: WritingLanguage,
  rendererAction: RendererActionSink,
  skills: readonly AgentSkillCatalogEntry[] = [],
  skillRoots: readonly string[] = [],
): AnyAgentTool[] {
  return [
    createNovelConfigTool(language, rendererAction),
    createStoryArchitectureTool(language, rendererAction),
    createReadArchitectureTool(language),
    createReadBlueprintTool(language),
    createManageDraftsTool(language, rendererAction),
    createReadProjectStateTool(language),
    createSearchKnowledgeTool(language),
    createManageKnowledgeBaseTool(language),
    createReadFileTool(language),
    createOpenEditorTool(language, rendererAction),
    createProposeChapterBlueprintTool(language),
    createManageCharactersTool(language, rendererAction),
    createManageMcpTool(language),
    createWebFetchTool(language),
    createManageSkillsTool(language, skills, skillRoots),
    ...buildMcpAgentTools(language),
  ].map(withExecutionMode)
}

/**
 * Build the tools dedicated to the Architecture Assistant.
 *
 * 架构助手专属工具集：聚焦于故事大纲、世界观设定、小说全局配置、人物体系与章节蓝图。
 * 严禁挂载底层破坏性写工具（write/edit/bash）与正文草稿工具（manage_drafts）。
 */
export function buildArchitectAgentTools(
  language: WritingLanguage,
  rendererAction: RendererActionSink,
): AnyAgentTool[] {
  return [
    createNovelConfigTool(language, rendererAction),
    createStoryArchitectureTool(language, rendererAction),
    createReadArchitectureTool(language),
    createReadBlueprintTool(language),
    createReadProjectStateTool(language),
    createSearchKnowledgeTool(language),
    createManageKnowledgeBaseTool(language),
    createReadFileTool(language),
    createOpenEditorTool(language, rendererAction),
    createProposeChapterBlueprintTool(language),
    createManageCharactersTool(language, rendererAction),
    createWebFetchTool(language),
  ].map(withExecutionMode)
}

/**
 * Build the tools dedicated to the Chapter Blueprint Assistant.
 *
 * 章节蓝图助手专属工具集：专注章节蓝图推演与落盘、前文状态感知、人物与世界观读取。
 * 严禁挂载底层写工具与正文草稿修改工具。
 */
export function buildBlueprintAgentTools(
  language: WritingLanguage,
  rendererAction: RendererActionSink,
): AnyAgentTool[] {
  return [
    createProposeChapterBlueprintTool(language),
    createReadBlueprintTool(language),
    createReadProjectStateTool(language),
    createReadArchitectureTool(language),
    createManageCharactersTool(language, rendererAction),
    createSearchKnowledgeTool(language),
    createReadFileTool(language),
    createOpenEditorTool(language, rendererAction),
    createWebFetchTool(language),
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
    'manage_drafts',
    'novel_config',
    'story_architecture',
    'propose_chapter_blueprint',
    'manage_characters',
    'manage_mcp',
    'manage_skills',
    'manage_knowledge_base',
  ])
}
