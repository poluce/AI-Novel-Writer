import { create } from 'zustand'
import { ipc } from '../services/ipc-client'
import { requireIpcSuccess } from '../services/ipc-result'
import { alertError } from '../components/ui/AlertDialog'
import type {
  CreationTaskKey,
  GlobalConfig,
  LLMFinishReason,
  LLMRequest,
  LLMStreamEvents,
  ModelDiscoveryResult,
  ModelDiscoveryRequest,
  ModelProfile,
  ProjectSessionContext,
  TaskModelConfig,
  TaskModelRouting,
  TokenUsage,
} from '../shared/ipc-channels'
import type { CreativeStrategy, GenerationReasoningStage, ReasoningEffort } from '../shared/reasoning-types'
import type { SubmitToolName } from '../shared/submit-contract'
import { readActiveProject, readActiveProjectSession } from '../services/active-project'
import { normalizeModelProfiles } from '../shared/model-profile'

/** 一次性生成回调：主进程只在完成时回一次。 */
interface StreamCallbacks {
  onDone?: (
    fullText: string,
    usage: TokenUsage | undefined,
    finishReason: LLMFinishReason,
    artifact?: Record<string, unknown>,
  ) => void
  onError?: (error: string) => void
}

interface GenerateStreamOptions {
  responseFormat?: { type: string }
  maxTokens?: number
  purpose?: string
  projectSession?: ProjectSessionContext
  creativeStrategy?: CreativeStrategy
  reasoningStage?: GenerationReasoningStage
  taskKey?: CreationTaskKey
  reasoningEffort?: ReasoningEffort
  submitTool?: SubmitToolName
}

type StreamMessage = { role: 'system' | 'user' | 'assistant'; content: string }
type ActiveRequest = { status: 'running' | 'done' | 'error'; text: string }
type DefaultModelChannel = 'llm:set-default-model' | 'llm:set-default-embedding-model'

interface LLMState {
  models: ModelProfile[]
  defaultModelId: string | null
  defaultEmbeddingModelId: string | null
  defaultThinkingLevel: ReasoningEffort
  taskModelRouting: TaskModelRouting
  activeRequests: Map<string, ActiveRequest>
  loaded: boolean

  init: () => Promise<void>
  loadModels: () => Promise<void>
  saveModel: (model: ModelProfile) => Promise<boolean>
  deleteModel: (modelId: string) => Promise<boolean>
  /** 设置默认生成模型（立即持久化到 ~/.vela/config.json） */
  setDefaultModel: (modelId: string) => Promise<boolean>
  /** 设置默认向量模型（立即持久化到 ~/.vela/config.json） */
  setDefaultEmbeddingModel: (modelId: string) => Promise<boolean>
  /** 设置全局默认思考强度（立即持久化到 ~/.vela/config.json） */
  setDefaultThinkingLevel: (level: ReasoningEffort) => Promise<boolean>
  resolveTaskModelId: (taskKey: CreationTaskKey) => string | null
  resolveTaskThinkingLevel: (taskKey: CreationTaskKey) => ReasoningEffort
  /** 设置指定任务的模型与思考配置（立即持久化到 config.json） */
  setTaskConfig: (taskKey: CreationTaskKey, config: TaskModelConfig) => Promise<boolean>
  resetTaskModelRouting: () => Promise<boolean>
  generateStream: (
    messages: StreamMessage[],
    callbacks: StreamCallbacks,
    modelId?: string,
    options?: GenerateStreamOptions,
  ) => Promise<string>
  cancelGeneration: (requestId: string) => Promise<void>
  testConnection: (model: ModelProfile) => Promise<{ success: boolean; error?: string }>
  discoverModels: (request: ModelDiscoveryRequest) => Promise<ModelDiscoveryResult>
}

let initializationFlight: Promise<void> | null = null

function firstGenerationModelId(models: ModelProfile[]): string | null {
  return models.find((model) => model.purposes?.includes('generation'))?.id ?? null
}

async function persistTaskRouting(routing: TaskModelRouting): Promise<boolean> {
  if (!ipc.isElectron) return true
  try {
    await ipc.invoke('config:set', { taskModelRouting: routing })
    return true
  } catch (error) {
    console.error('[LLMStore] Failed to save task model routing:', error)
    return false
  }
}

async function persistDefaultModelId(
  channel: DefaultModelChannel,
  modelId: string,
  action: string,
): Promise<boolean> {
  try {
    requireIpcSuccess(await ipc.invoke(channel, modelId), action)
    return true
  } catch (error) {
    alertError(String(error), { title: '模型设置保存失败' })
    return false
  }
}

function notifyStreamDone(
  callbacks: StreamCallbacks,
  data: LLMStreamEvents['llm:stream-done'],
): void {
  const finishReason = data.finishReason ?? 'unknown'
  if (data.artifact !== undefined) {
    callbacks.onDone?.(data.fullText, data.usage, finishReason, data.artifact)
    return
  }
  callbacks.onDone?.(data.fullText, data.usage, finishReason)
}

function resolveStreamReasoningStage(
  options: GenerateStreamOptions | undefined,
): GenerationReasoningStage {
  if (options?.reasoningStage) return options.reasoningStage
  if (options?.responseFormat) return 'planning'
  return 'drafting'
}

function buildStreamRequest(
  modelId: string,
  messages: StreamMessage[],
  options: GenerateStreamOptions | undefined,
  extras: {
    creativeStrategy: CreativeStrategy
    projectSession: ProjectSessionContext | undefined
    taskKey: CreationTaskKey | undefined
    reasoningEffort: ReasoningEffort | undefined
  },
): LLMRequest {
  const request: LLMRequest = {
    modelId,
    purpose: options?.purpose ?? 'generation',
    creativeStrategy: extras.creativeStrategy,
    reasoningStage: resolveStreamReasoningStage(options),
    taskKey: extras.taskKey,
    reasoningEffort: extras.reasoningEffort,
    projectSession: extras.projectSession,
    messages,
    stream: true,
    responseFormat: options?.responseFormat as { type: 'json_object' | 'text' } | undefined,
    maxTokens: options?.maxTokens,
  }
  if (options?.submitTool) {
    request.submitTool = options.submitTool
  }
  return request
}

export const useLLMStore = create<LLMState>()((set, get) => {
  function patchActiveRequests(mutate: (requests: Map<string, ActiveRequest>) => void): void {
    const requests = new Map(get().activeRequests)
    mutate(requests)
    set({ activeRequests: requests })
  }

  async function loadInitialState(): Promise<void> {
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
    const configObj = config as GlobalConfig | null
    set({
      models,
      defaultModelId: defaultModelId ?? firstGenerationModelId(models),
      defaultEmbeddingModelId,
      defaultThinkingLevel: configObj?.defaultThinkingLevel ?? 'low',
      taskModelRouting: configObj?.taskModelRouting ?? {},
      loaded: true,
    })
  }

  function init(): Promise<void> {
    if (get().loaded) return Promise.resolve()
    if (initializationFlight) return initializationFlight
    const flight = loadInitialState().finally(() => {
      if (initializationFlight === flight) initializationFlight = null
    })
    initializationFlight = flight
    return flight
  }

  async function loadModels(): Promise<void> {
    if (!ipc.isElectron) return
    const rawModels = await ipc.invoke('llm:list-models')
    set({ models: normalizeModelProfiles(rawModels) })
  }

  async function saveModel(model: ModelProfile): Promise<boolean> {
    const result = await ipc.invoke('llm:save-model', model)
    if (result.success) {
      await loadModels()
    } else {
      alertError('保存模型失败', { title: '模型设置保存失败' })
    }
    return result.success
  }

  async function deleteModel(modelId: string): Promise<boolean> {
    const result = await ipc.invoke('llm:delete-model', modelId)
    if (!result.success) {
      alertError(result.error || '删除模型失败', { title: '模型删除失败' })
      return false
    }
    await loadModels()
    set({
      defaultModelId: result.defaultModelId ?? null,
      defaultEmbeddingModelId: result.defaultEmbeddingModelId ?? null,
    })
    return true
  }

  async function setDefaultModel(modelId: string): Promise<boolean> {
    const persisted = await persistDefaultModelId('llm:set-default-model', modelId, '保存默认模型')
    if (persisted) set({ defaultModelId: modelId })
    return persisted
  }

  async function setDefaultEmbeddingModel(modelId: string): Promise<boolean> {
    const persisted = await persistDefaultModelId(
      'llm:set-default-embedding-model',
      modelId,
      '保存默认向量模型',
    )
    if (persisted) set({ defaultEmbeddingModelId: modelId })
    return persisted
  }

  async function setDefaultThinkingLevel(level: ReasoningEffort): Promise<boolean> {
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
  }

  function resolveTaskModelId(taskKey: CreationTaskKey): string | null {
    const routing = get().taskModelRouting
    const candidateId = routing[taskKey]?.modelId?.trim()
    if (candidateId) {
      const exists = get().models.some(m => m.id === candidateId)
      if (exists) return candidateId
    }
    return get().defaultModelId
      ?? get().models.find(m => m.purposes?.includes('generation'))?.id
      ?? null
  }

  function resolveTaskThinkingLevel(taskKey: CreationTaskKey): ReasoningEffort {
    const configured = get().taskModelRouting[taskKey]?.thinkingLevel
    if (configured && configured !== 'auto') {
      return configured
    }
    return get().defaultThinkingLevel ?? 'low'
  }

  async function setTaskConfig(
    taskKey: CreationTaskKey,
    taskConfig: TaskModelConfig,
  ): Promise<boolean> {
    const nextRouting: TaskModelRouting = {
      ...get().taskModelRouting,
      [taskKey]: taskConfig,
    }
    set({ taskModelRouting: nextRouting })
    return persistTaskRouting(nextRouting)
  }

  async function resetTaskModelRouting(): Promise<boolean> {
    set({ taskModelRouting: {} })
    return persistTaskRouting({})
  }

  async function generateStream(
    messages: StreamMessage[],
    callbacks: StreamCallbacks,
    modelId?: string,
    options?: GenerateStreamOptions,
  ): Promise<string> {
    const taskKey = options?.taskKey
    const taskModelId = taskKey ? resolveTaskModelId(taskKey) : null
    const mid = modelId ?? taskModelId ?? get().defaultModelId
    if (!mid) {
      callbacks.onError?.('未配置默认模型')
      return ''
    }

    let taskThinking: ReasoningEffort | 'auto'
    if (options?.reasoningEffort != null) {
      taskThinking = options.reasoningEffort
    } else if (taskKey) {
      taskThinking = resolveTaskThinkingLevel(taskKey)
    } else {
      taskThinking = 'auto'
    }
    const effectiveEffort = taskThinking === 'auto' ? undefined : taskThinking
    const requestId = crypto.randomUUID()
    const projectSession = options?.projectSession
      ?? readActiveProjectSession()
      ?? undefined
    const creativeStrategy = options?.creativeStrategy
      ?? readActiveProject()?.novelConfig.creativeStrategy
      ?? 'auto'

    let unsubDone = (): void => {}
    let unsubError = (): void => {}

    function cleanup(): void {
      unsubDone()
      unsubError()
      patchActiveRequests((requests) => {
        requests.delete(requestId)
      })
    }

    unsubDone = ipc.on('llm:stream-done', (data) => {
      if (data.requestId !== requestId) return
      notifyStreamDone(callbacks, data)
      cleanup()
    })
    unsubError = ipc.on('llm:stream-error', (data) => {
      if (data.requestId !== requestId) return
      callbacks.onError?.(data.error)
      cleanup()
    })

    patchActiveRequests((requests) => {
      requests.set(requestId, { status: 'running', text: '' })
    })

    let started: { requestId: string; started: boolean; error?: string }
    try {
      started = await ipc.invoke(
        'llm:generate-stream',
        requestId,
        buildStreamRequest(mid, messages, options, {
          creativeStrategy,
          projectSession,
          taskKey,
          reasoningEffort: effectiveEffort,
        }),
      )
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
  }

  async function cancelGeneration(requestId: string): Promise<void> {
    await ipc.invoke('llm:cancel', requestId)
  }

  function testConnection(
    model: ModelProfile,
  ): Promise<{ success: boolean; error?: string }> {
    return ipc.invoke(
      'llm:test-connection',
      model,
      readActiveProject()?.novelConfig.creativeStrategy ?? 'auto',
    )
  }

  function discoverModels(request: ModelDiscoveryRequest): Promise<ModelDiscoveryResult> {
    return ipc.invoke('llm:discover-models', request)
  }

  return {
    models: [],
    defaultModelId: null,
    defaultEmbeddingModelId: null,
    defaultThinkingLevel: 'low',
    taskModelRouting: {},
    activeRequests: new Map(),
    loaded: false,
    init,
    loadModels,
    saveModel,
    deleteModel,
    setDefaultModel,
    setDefaultEmbeddingModel,
    setDefaultThinkingLevel,
    resolveTaskModelId,
    resolveTaskThinkingLevel,
    setTaskConfig,
    resetTaskModelRouting,
    generateStream,
    cancelGeneration,
    testConnection,
    discoverModels,
  }
})
