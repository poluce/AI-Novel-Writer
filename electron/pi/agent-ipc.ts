import { ipcMain, BrowserWindow } from 'electron'

import { AgentSessionManager } from './agent-session-manager'

import {
  readJsonFile,
  MODELS_CONFIG_PATH,
  GLOBAL_CONFIG_PATH,
  DEFAULT_GLOBAL_CONFIG,
} from '../utils/config-utils'
import { ProjectCoreRepository } from '../repositories/project-core-repository'
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
  return buildMainProcessAgentSystemPrompt(ProjectCoreRepository.get())
}

function mainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

/** Register the agent IPC surface (main-process Pi Agent). */
export function registerAgentController(): void {
  const manager = new AgentSessionManager({
    resolveModel,
    resolveSystemPrompt: () => resolveSystemPrompt(),
    resolveLanguage: () => resolveLanguage(),
    emit: (conversationId, event) => {
      mainWindow()?.webContents.send('agent:event', { conversationId, event })
    },
    rendererAction: (action) => {
      mainWindow()?.webContents.send('agent:renderer-action', { action })
    },
  })

  ipcMain.handle('agent:prompt', async (_event, conversationId: string, input: string, modelId?: string) => {
    return manager.prompt(conversationId, input, modelId)
  })

  ipcMain.handle('agent:confirm', async (_event, conversationId: string, toolCallId: string, confirmed: boolean) => {
    return manager.confirm(conversationId, toolCallId, confirmed)
  })

  ipcMain.handle('agent:abort', async (_event, conversationId: string) => {
    return manager.abort(conversationId)
  })
}
