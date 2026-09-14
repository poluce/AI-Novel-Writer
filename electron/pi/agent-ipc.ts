import { ipcMain, BrowserWindow } from 'electron'

import { AgentSessionManager } from './agent-session-manager'
import { setPiProjectCloseHook } from './in-flight'
import { createRendererActionDispatcher } from './renderer-action-dispatch'
import type { AgentEditorSnapshot, RendererActionResult } from '../../src/shared/agent-events'
import { isAgentSkillCatalog, type AgentSkillCatalogEntry } from '../../src/shared/agent-skills'
import type { AgentPromptHistoryTurn } from '../../src/shared/agent-conversation-archive'

import {
  readJsonFile,
  MODELS_CONFIG_PATH,
  GLOBAL_CONFIG_PATH,
  DEFAULT_GLOBAL_CONFIG,
} from '../utils/config-utils'
import { getCurrentProjectPath } from '../database'
import { logFailure } from '../../src/shared/fail-log'
import { ProjectCoreRepository } from '../repositories/project-core-repository'
import { loadAssistantWritingIdentity } from './assistant-identity-loader'
import { buildMainProcessAgentSystemPrompt } from './agent-system-prompt'
import type { GlobalConfig, ModelProfile } from '../../src/shared/ipc-channels'
import {
  DEFAULT_WRITING_LANGUAGE,
  type WritingLanguage,
} from '../../src/shared/writing-language'

function resolveModel(modelId: string | undefined): ModelProfile | null {
  const models = readJsonFile<ModelProfile[]>(MODELS_CONFIG_PATH, [])
  if (modelId) return models.find((m) => m.id === modelId) ?? null
  const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
  const defaultId = config.defaultModelId
  return models.find((m) => m.id === defaultId) ?? models[0] ?? null
}

function resolveLanguage(): WritingLanguage {
  const core = ProjectCoreRepository.get()
  return core?.writingLanguage ?? DEFAULT_WRITING_LANGUAGE
}

function resolveSystemPrompt(skills?: readonly AgentSkillCatalogEntry[]): string {
  const core = ProjectCoreRepository.get()
  const language = core?.writingLanguage ?? DEFAULT_WRITING_LANGUAGE
  return buildMainProcessAgentSystemPrompt(
    core,
    loadAssistantWritingIdentity(language, { projectPath: getCurrentProjectPath() }),
    skills,
  )
}

/**
 * The renderer owns skill loading (project session validation, localized
 * copy), so the catalog arrives over IPC. A malformed payload is dropped
 * instead of failing the turn: the prompt then simply lists no skills.
 */
function acceptedSkillCatalog(value: unknown): AgentSkillCatalogEntry[] | undefined {
  if (value === undefined) return undefined
  if (!isAgentSkillCatalog(value)) {
    logFailure('Agent', 'rejected malformed skill catalog', undefined, {
      received: Array.isArray(value) ? value.length : typeof value,
    })
    return undefined
  }
  return value
}

function mainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

function isWorkflowLaunchReceipt(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const record = value as { runId?: unknown; status?: unknown; name?: unknown }
  return typeof record.runId === 'string'
    && typeof record.status === 'string'
    && typeof record.name === 'string'
}

function isRendererActionResult(value: unknown): value is RendererActionResult {
  if (!value || typeof value !== 'object') return false
  const result = value as RendererActionResult
  if (result.ok === true) {
    return typeof result.summary === 'string'
      && (result.workflow === undefined || isWorkflowLaunchReceipt(result.workflow))
  }
  if (result.ok === false) return typeof result.error === 'string'
  return false
}

/** Register the agent IPC surface (main-process Pi Agent). */
export function registerAgentController(): void {
  const dispatcher = createRendererActionDispatcher({
    mainWindow,
    messages: () => {
      const language = resolveLanguage()
      return language === 'en-US'
        ? {
          noWindow: 'The application window is not available, so the workflow was not started.',
          timeout: 'Workflow start timed out before the task panel registered the run.',
          aborted: 'Workflow start was aborted before the task panel registered the run.',
        }
        : {
          noWindow: '应用窗口不可用，工作流未启动。',
          timeout: '工作流启动超时，任务中心未确认注册。',
          aborted: '工作流启动已中止，任务中心未确认注册。',
        }
    },
  })
  const manager = new AgentSessionManager({
    resolveModel,
    resolveSystemPrompt: (_conversationId, skills) => resolveSystemPrompt(skills),
    resolveLanguage: () => resolveLanguage(),
    emit: (conversationId, event) => {
      mainWindow()?.webContents.send('agent:event', { conversationId, event })
    },
    rendererAction: (action) => dispatcher.rendererAction(action),
  })
  setPiProjectCloseHook(() => {
    dispatcher.abortAll()
    manager.abortAll()
  })

  ipcMain.handle('agent:prompt', async (
    _event,
    conversationId: string,
    input: string,
    modelId?: string,
    editorSnapshot?: AgentEditorSnapshot,
    history?: AgentPromptHistoryTurn[],
    skills?: unknown,
  ) => {
    return manager.prompt(
      conversationId,
      input,
      modelId,
      editorSnapshot,
      history,
      acceptedSkillCatalog(skills),
    )
  })

  ipcMain.handle('agent:confirm', async (_event, conversationId: string, toolCallId: string, confirmed: boolean) => {
    return manager.confirm(conversationId, toolCallId, confirmed)
  })

  ipcMain.handle('agent:abort', async (_event, conversationId: string) => {
    dispatcher.abortAll()
    return manager.abort(conversationId)
  })

  ipcMain.handle('agent:renderer-action-result', async (_event, requestId: string, result: RendererActionResult) => {
    if (!requestId || typeof requestId !== 'string' || !isRendererActionResult(result)) {
      return { success: false }
    }
    return { success: dispatcher.complete(requestId, result) }
  })

  ipcMain.handle('agent:system-prompt', async (_event, skills?: unknown) => {
    try {
      return { success: true, prompt: resolveSystemPrompt(acceptedSkillCatalog(skills)) }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })
}
