import { ipcMain, BrowserWindow } from 'electron'

import { AgentSessionManager } from './agent-session-manager'
import { setPiProjectCloseHook } from './in-flight'
import { createRendererActionDispatcher } from './renderer-action-dispatch'
import type { AgentEditorSnapshot, RendererActionResult } from '../../src/shared/agent-events'
import type { AgentPromptHistoryTurn } from '../../src/shared/agent-conversation-archive'

import {
  readJsonFile,
  MODELS_CONFIG_PATH,
  GLOBAL_CONFIG_PATH,
  DEFAULT_GLOBAL_CONFIG,
} from '../utils/config-utils'
import { getCurrentProjectPath } from '../database'
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

function resolveSystemPrompt(): string {
  const core = ProjectCoreRepository.get()
  const language = core?.writingLanguage ?? DEFAULT_WRITING_LANGUAGE
  return buildMainProcessAgentSystemPrompt(
    core,
    loadAssistantWritingIdentity(language, { projectPath: getCurrentProjectPath() }),
  )
}

function mainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

function isRendererActionResult(value: unknown): value is RendererActionResult {
  if (!value || typeof value !== 'object') return false
  const result = value as RendererActionResult
  if (result.ok === true) return typeof result.summary === 'string'
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
    resolveSystemPrompt: () => resolveSystemPrompt(),
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
  ) => {
    return manager.prompt(conversationId, input, modelId, editorSnapshot, history)
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

  ipcMain.handle('agent:system-prompt', async () => {
    try {
      return { success: true, prompt: resolveSystemPrompt() }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })
}
