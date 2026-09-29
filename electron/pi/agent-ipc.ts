import { ipcMain, BrowserWindow } from 'electron'

import { AgentSessionManager } from './agent-session-manager'
import { AgentConversationStore } from './agent-conversation-store'
import { setPiProjectCloseHook } from './in-flight'
import { projectExecutionEnv } from './execution-tools'
import { projectSkillsRoot, userSkillsRoot } from '../services/writing-skill-catalog'
import { createRendererActionDispatcher } from './renderer-action-dispatch'
import type { AgentEditorSnapshot, RendererActionResult } from '../../src/shared/agent-events'
import {
  acceptedAssistantThinkingLevel,
} from '../../src/shared/agent-runtime'
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
import { normalizeModelProfiles } from '../../src/shared/model-profile'

function resolveModel(modelId: string | undefined): ModelProfile | null {
  const models = normalizeModelProfiles(readJsonFile<unknown[]>(MODELS_CONFIG_PATH, []))
  if (models.length === 0) return null

  if (modelId) {
    const byId = models.find((m) => m.id === modelId)
    if (byId) return byId
    const byName = models.find((m) => m.modelName === modelId)
    if (byName) return byName
  }

  const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
  const assistantConfigId = config.taskModelRouting?.assistant?.modelId?.trim()
  const defaultId = assistantConfigId || config.defaultModelId

  if (defaultId) {
    const foundDefault = models.find((m) => m.id === defaultId)
      ?? models.find((m) => m.modelName === defaultId)
    if (foundDefault) return foundDefault
  }

  return models.find((m) => m.purposes?.includes('generation')) ?? models[0] ?? null
}

function resolveLanguage(): WritingLanguage {
  const core = ProjectCoreRepository.get()
  return core?.writingLanguage ?? DEFAULT_WRITING_LANGUAGE
}

function resolveSystemPrompt(
  skills?: readonly AgentSkillCatalogEntry[],
): string {
  // 助手只在项目内工作：L0 项目事实与项目级身份覆盖都以当前书为准。
  const core = ProjectCoreRepository.get()
  const projectPath = getCurrentProjectPath()
  const language = core?.writingLanguage ?? DEFAULT_WRITING_LANGUAGE
  return buildMainProcessAgentSystemPrompt(
    core,
    loadAssistantWritingIdentity(language, { projectPath }),
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

/**
 * 助手会话存档跟着当前项目走：换书必须换存档，且旧存档要关掉文件句柄。
 * 没有打开项目时不创建存档（此时助手不可用，由会话管理器拒绝这一轮）。
 */
let conversationStore: AgentConversationStore | null = null
let conversationStorePath: string | null = null

function resolveConversationStore(): AgentConversationStore | null {
  const projectPath = getCurrentProjectPath()
  if (!projectPath) {
    closeConversationStore()
    return null
  }
  if (conversationStore && conversationStorePath === projectPath) return conversationStore
  closeConversationStore()
  conversationStore = AgentConversationStore.forProject(projectPath)
  conversationStorePath = projectPath
  return conversationStore
}

function closeConversationStore(): void {
  const store = conversationStore
  conversationStore = null
  conversationStorePath = null
  if (!store) return
  void store.close().catch((error) => {
    logFailure('Agent', 'failed to close conversation store', error)
  })
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
    resolveConversationStore: () => resolveConversationStore(),
    // 执行工具的沙箱钉在项目根；没有项目时助手整体不可用。
    resolveToolEnvironment: () => {
      const projectPath = getCurrentProjectPath()
      return projectPath ? projectExecutionEnv(projectPath) : null
    },
    // 技能正文以磁盘为准：只有落在技能根内的路径才允许直读。
    resolveSkillRoots: () => {
      const roots: string[] = []
      const userRoot = userSkillsRoot()
      if (userRoot) roots.push(userRoot)
      const projectPath = getCurrentProjectPath()
      if (projectPath) roots.push(projectSkillsRoot(projectPath))
      return roots
    },
    // 助手对话与工作流共用同一条采样参数策略：策略取自项目创作策略。
    resolveCreativeStrategy: () => ProjectCoreRepository.get()?.creativeStrategy,
  })
  setPiProjectCloseHook(() => {
    dispatcher.abortAll()
    manager.abortAll()
    // 助手存档跟着项目走，随项目关闭一起收起。
    closeConversationStore()
  })

  ipcMain.handle('agent:prompt', async (
    _event,
    conversationId: string,
    input: string,
    modelId?: string,
    editorSnapshot?: AgentEditorSnapshot,
    history?: AgentPromptHistoryTurn[],
    skills?: unknown,
    thinkingLevel?: unknown,
    executionMode?: unknown,
  ) => {
    const resolvedExecutionMode: 'plan' | 'writing' = executionMode === 'writing' ? 'writing' : 'plan'
    return manager.prompt(
      conversationId,
      input,
      modelId,
      editorSnapshot,
      history,
      acceptedSkillCatalog(skills),
      acceptedAssistantThinkingLevel(thinkingLevel),
      resolvedExecutionMode,
    )
  })

  ipcMain.handle('agent:confirm', async (_event, conversationId: string, toolCallId: string, confirmed: boolean) => {
    return manager.confirm(conversationId, toolCallId, confirmed)
  })

  ipcMain.handle('agent:discard-session', async (_event, conversationId: string) => {
    if (!conversationId || typeof conversationId !== 'string') return { success: false }
    return manager.discard(conversationId)
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
      return {
        success: true,
        prompt: resolveSystemPrompt(acceptedSkillCatalog(skills)),
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  ipcMain.handle('agent:list-conversations', async () => {
    try {
      const result = await manager.listConversations()
      return { success: true, conversations: result.conversations, activeConversationId: result.activeConversationId }
    } catch (error) {
      logFailure('Agent', 'failed to list conversations', error)
      return { success: false, conversations: [], activeConversationId: null, error: String(error) }
    }
  })

  ipcMain.handle('agent:rename-conversation', async (_event, conversationId: string, title: string) => {
    if (!conversationId || typeof conversationId !== 'string' || typeof title !== 'string') {
      return { success: false, error: '参数无效' }
    }
    try {
      const success = await manager.renameConversation(conversationId, title.trim())
      return { success }
    } catch (error) {
      logFailure('Agent', 'failed to rename conversation', error, { conversationId })
      return { success: false, error: String(error) }
    }
  })
}
