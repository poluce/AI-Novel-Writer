import type { AgentTool } from '@earendil-works/pi-agent-core'

import type { WritingLanguage } from '../../src/shared/writing-language'
import type { RendererActionSink } from '../../src/shared/agent-events'

import { createListChaptersTool } from './tools/list-chapters.tool'
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
import { createProposeNovelConfigTool } from './tools/propose-novel-config.tool'
import { createProposeChapterBlueprintTool } from './tools/propose-chapter-blueprint.tool'
import { buildMcpAgentTools } from './tools/mcp.tool'
import { truncateToolText } from './tool-result'

function withTruncatedResult(tool: AgentTool<any>): AgentTool<any> {
  return {
    ...tool,
    execute: async (id, params, signal) => {
      const result = await tool.execute(id, params, signal)
      return {
        ...result,
        content: result.content.map(block => (
          block.type === 'text'
            ? { ...block, text: truncateToolText(block.text) }
            : block
        )),
      }
    },
  }
}

/** Build built-in + currently connected MCP tools for one agent session. */
export function buildAgentTools(
  language: WritingLanguage,
  rendererAction: RendererActionSink,
): AgentTool<any>[] {
  return [
    createListChaptersTool(language),
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
    createProposeNovelConfigTool(language, rendererAction),
    createProposeChapterBlueprintTool(language),
    ...buildMcpAgentTools(language),
  ].map(withTruncatedResult)
}

/** Write tools that must be confirmed by the user before execution. */
export function confirmationToolNames(): ReadonlySet<string> {
  return new Set([
    'write_file',
    'open_editor',
    'start_workflow',
    'propose_novel_config',
    'propose_chapter_blueprint',
    'install_writing_skill',
    'bind_writing_skill',
  ])
}
