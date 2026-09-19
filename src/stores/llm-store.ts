import { create } from 'zustand'
import { ipc } from '../services/ipc-client'
import { requireIpcSuccess } from '../services/ipc-result'
import { alertError } from '../components/ui/AlertDialog'
import type {
  CreationTaskKey,
  GlobalConfig,
  LLMFinishReason,
  ModelDiscoveryResult,
  ModelDiscoveryRequest,
  ModelProfile,
  TaskModelConfig,
  TaskModelRouting,
  TokenUsage,
} from '../shared/ipc-channels'
import type { CreativeStrategy, GenerationReasoningStage, ReasoningEffort } from '../shared/reasoning-types'
import type { SubmitToolName } from '../shared/submit-contract'
import { readActiveProject, readActiveProjectSession } from '../services/active-project'
import { normalizeModelProfiles } from '../shared/model-profile'

/** 一次性生成的回调（正文不再流式：主进程只在完成时回一次） */
interface StreamCallbacks {
  onDone?: (
    fullText: string,
    usage: TokenUsage | undefined,
    finishReason: LLMFinishReason,
    artifact?: Record<string, unknown>,
  ) => void
  onError?: (error: string) => void
}

interface LLMState {
  /** 已配置的模型列表 */
  models: ModelProfile[]
  /** 当前默认生成模型 ID */
  defaultModelId: string | null
  /** 当前默认向量模型 ID */
  defaultEmbeddingModelId: string | null
  /** 全局默认思考强度 */
  defaultThinkingLevel: ReasoningEffort
  /** 各创作环节专属模型与思考调度矩阵 */
  taskModelRouting: TaskModelRouting
  /** 正在进行的活跃请求 */
  activeRequests: Map<string, { status: 'running' | 'done' | 'error'; text: string }>
  /** 是否已加载模型配置 */
  loaded: boolean

  // ===== Actions =====
  /** 初始化（加载模型列表 + 默认模型 ID + 任务模型调度） */
  init: () => Promise<void>
  /** 加载模型列表 */
  loadModels: () => Promise<void>
  /** 保存模型 */
  saveModel: (model: ModelProfile) => Promise<boolean>
  /** 删除模型 */
  deleteModel: (modelId: string) => Promise<boolean>
  /** 设置默认生成模型（持久化到 ~/.vela/config.json） */
  setDefaultModel: (modelId: string) => Promise<boolean>
  /** 设置默认向量模型（持久化到 ~/.vela/config.json） */
  setDefaultEmbeddingModel: (modelId: string) => Promise<boolean>
  /** 设置全局默认思考强度（持久化到 ~/.vela/config.json） */
  setDefaultThinkingLevel: (level: ReasoningEffort) => Promise<boolean>
  /** 解析指定任务应该使用的模型 ID（优先专属配置，优雅回退默认模型） */
  resolveTaskModelId: (taskKey: CreationTaskKey) => string | null
  /** 解析指定任务应该使用的思考强度 */
  resolveTaskThinkingLevel: (taskKey: CreationTaskKey) => ReasoningEffort
  /** 设置指定任务的模型与思考配置（自动持久化到 config.json） */
  setTaskConfig: (taskKey: CreationTaskKey, config: TaskModelConfig) => Promise<boolean>
  /** 重置所有任务调度为默认 */
  resetTaskModelRouting: () => Promise<boolean>
  /** 流式生成 */
  generateStream: (
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    callbacks: StreamCallbacks,
    modelId?: string,
    options?: {
      responseFormat?: { type: string }
      maxTokens?: number
      purpose?: string
      projectSession?: import('../shared/ipc-channels').ProjectSessionContext
      creativeStrategy?: CreativeStrategy
      reasoningStage?: GenerationReasoningStage
      taskKey?: CreationTaskKey
      reasoningEffort?: ReasoningEffort
      submitTool?: SubmitToolName
    }
  ) => Promise<string>
  /** 取消生成 */
  cancelGeneration: (requestId: string) => Promise<void>
  /** 测试模型连接 */
  testConnection: (model: ModelProfile) => Promise<{ success: boolean; error?: string }>
  /** 以当前表单中的端点和凭据主动发现 provider 模型。 */
  discoverModels: (request: ModelDiscoveryRequest) => Promise<ModelDiscoveryResult>
}

let initializationFlight: Promise<void> | null = null

export const useLLMStore = create<LLMState>()((set, get) => ({
  models: [],
  defaultModelId: null,
  defaultEmbeddingModelId: null,
  defaultThinkingLevel: 'low',
  taskModelRouting: {},
  activeRequests: new Map(),
  loaded: false,

  init: () => {
    if (get().loaded) return Promise.resolve()
    if (initializationFlight) return initializationFlight

    const flight = (async () => {
      if (!ipc.isElectron) {
        set({ loaded: true })
        return
      }
      const [rawModels, defaultModelId, defaultEmbeddingModelId, config] = await Promise.all([
        ipc.invoke('llm:list-models'),
        ipc.invoke('llm:get-default-model'),
        ipc.invoke('llm:get-default-embedding-model'),
        ipc.invoke('config:get').catch(() => null),
      ])
      const models = normalizeModelProfiles(rawModels)
      const resolvedDefaultModelId = defaultModelId
        ?? models.find(m => m.purposes.includes('generation'))?.id
        ?? null
      const configObj = config as GlobalConfig | null
      set({
        models,
        defaultModelId: resolvedDefaultModelId,
        defaultEmbeddingModelId,
        defaultThinkingLevel: configObj?.defaultThinkingLevel ?? 'low',
        taskModelRouting: configObj?.taskModelRouting ?? {},
        loaded: true,
      })
    })().finally(() => {
      if (initializationFlight === flight) initializationFlight = null
    })
    initializationFlight = flight
    return flight
  },

  loadModels: async () => {
    if (!ipc.isElectron) return
    const rawModels = await ipc.invoke('llm:list-models')
    set({ models: normalizeModelProfiles(rawModels) })
  },

  saveModel: async (model) => {
    const result = await ipc.invoke('llm:save-model', model)
    if (result.success) {
      await get().loadModels()
    } else {
      alertError('保存模型失败', { title: '模型设置保存失败' })
    }
    return result.success
  },

  deleteModel: async (modelId) => {
    const result = await ipc.invoke('llm:delete-model', modelId)
    if (!result.success) {
      alertError(result.error || '删除模型失败', { title: '模型删除失败' })
      return false
    }
    await get().loadModels()
    set({
      defaultModelId: result.defaultModelId ?? null,
      defaultEmbeddingModelId: result.defaultEmbeddingModelId ?? null,
    })
    return true
  },

  setDefaultModel: async (modelId) => {
    try {
      requireIpcSuccess(await ipc.invoke('llm:set-default-model', modelId), '保存默认模型')
      set({ defaultModelId: modelId })
      return true
    } catch (error) {
      alertError(String(error), { title: '模型设置保存失败' })
      return false
    }
  },

  setDefaultEmbeddingModel: async (modelId) => {
    try {
      requireIpcSuccess(
        await ipc.invoke('llm:set-default-embedding-model', modelId),
        '保存默认向量模型',
      )
      set({ defaultEmbeddingModelId: modelId })
      return true
    } catch (error) {
      alertError(String(error), { title: '模型设置保存失败' })
      return false
    }
  },

  setDefaultThinkingLevel: async (level) => {
    try {
      set({ defaultThinkingLevel: level })
      if (ipc.isElectron) {
        await ipc.invoke('config:set', { defaultThinkingLevel: level })
      }
      return true
    } catch (error) {
      alertError(String(error), { title: '思考强度设置保存失败' })
      return false
    }
  },

  resolveTaskModelId: (taskKey: CreationTaskKey) => {
    const routing = get().taskModelRouting
    const candidateId = routing[taskKey]?.modelId?.trim()
    if (candidateId) {
      const exists = get().models.some(m => m.id === candidateId)
      if (exists) return candidateId
    }
    return get().defaultModelId
      ?? get().models.find(m => m.purposes?.includes('generation'))?.id
      ?? null
  },

  resolveTaskThinkingLevel: (taskKey: CreationTaskKey) => {
    const configured = get().taskModelRouting[taskKey]?.thinkingLevel
    if (configured && configured !== 'auto') {
      return configured
    }
    return get().defaultThinkingLevel ?? 'low'
  },

  setTaskConfig: async (taskKey: CreationTaskKey, taskConfig: TaskModelConfig) => {
    const currentRouting = get().taskModelRouting
    const nextRouting: TaskModelRouting = {
      ...currentRouting,
      [taskKey]: taskConfig,
    }
    set({ taskModelRouting: nextRouting })
    if (ipc.isElectron) {
      try {
        await ipc.invoke('config:set', { taskModelRouting: nextRouting })
        return true
      } catch (err) {
        console.error('[LLMStore] Failed to save task model routing:', err)
        return false
      }
    }
    return true
  },

  resetTaskModelRouting: async () => {
    set({ taskModelRouting: {} })
    if (ipc.isElectron) {
      try {
        await ipc.invoke('config:set', { taskModelRouting: {} })
        return true
      } catch (err) {
        console.error('[LLMStore] Failed to reset task model routing:', err)
        return false
      }
    }
    return true
  },

  generateStream: async (messages, callbacks, modelId, options) => {
    const taskKey = options?.taskKey
    const taskModelId = taskKey ? get().resolveTaskModelId(taskKey) : null
    const mid = modelId ?? taskModelId ?? get().defaultModelId
    if (!mid) {
      callbacks.onError?.('未配置默认模型')
      return ''
    }

    const taskThinking = options?.reasoningEffort ?? (taskKey ? get().resolveTaskThinkingLevel(taskKey) : 'auto')
    const effectiveEffort = taskThinking === 'auto' ? undefined : taskThinking

    const requestId = crypto.randomUUID()
    const projectSession = options?.projectSession
      ?? readActiveProjectSession()
      ?? undefined
    const creativeStrategy = options?.creativeStrategy
      ?? readActiveProject()?.novelConfig.creativeStrategy
      ?? 'auto'

    // 注册完成/失败事件监听
    const unsubDone = ipc.on('llm:stream-done', (data) => {
      if (data.requestId === requestId) {
        if (data.artifact !== undefined) {
          callbacks.onDone?.(data.fullText, data.usage, data.finishReason ?? 'unknown', data.artifact)
        } else {
          callbacks.onDone?.(data.fullText, data.usage, data.finishReason ?? 'unknown')
        }
        cleanup()
      }
    })

    const unsubError = ipc.on('llm:stream-error', (data) => {
      if (data.requestId === requestId) {
        callbacks.onError?.(data.error)
        cleanup()
      }
    })

    const cleanup = () => {
      unsubDone()
      unsubError()
      const reqs = new Map(get().activeRequests)
      reqs.delete(requestId)
      set({ activeRequests: reqs })
    }

    // 标记活跃请求
    const reqs = new Map(get().activeRequests)
    reqs.set(requestId, { status: 'running', text: '' })
    set({ activeRequests: reqs })

    // 发起流式请求
    let started: { requestId: string; started: boolean; error?: string }
    try {
      started = await ipc.invoke('llm:generate-stream', requestId, {
        modelId: mid,
        purpose: options?.purpose ?? 'generation',
        creativeStrategy,
        reasoningStage: options?.reasoningStage
          ?? (options?.responseFormat ? 'planning' : 'drafting'),
        taskKey,
        reasoningEffort: effectiveEffort,
        projectSession,
        messages,
        stream: true,
        responseFormat: options?.responseFormat as { type: 'json_object' | 'text' } | undefined,
        maxTokens: options?.maxTokens,
        ...(options?.submitTool ? { submitTool: options.submitTool } : {}),
      })
    } catch (error) {
      cleanup()
      callbacks.onError?.(String(error))
      throw error
    }
    if (!started.started) {
      cleanup()
      const startError = started.error || '模型流式生成未能启动'
      callbacks.onError?.(startError)
      throw new Error(startError)
    }

    return requestId
  },

  cancelGeneration: async (requestId) => {
    await ipc.invoke('llm:cancel', requestId)
  },

  testConnection: async (model) => {
    return ipc.invoke(
      'llm:test-connection',
      model,
      readActiveProject()?.novelConfig.creativeStrategy ?? 'auto',
    )
  },

  discoverModels: async (request) => ipc.invoke('llm:discover-models', request),
}))
