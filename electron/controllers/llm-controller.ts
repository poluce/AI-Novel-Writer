import { ipcMain, BrowserWindow } from 'electron'
import {
  readJsonFile,
  tryReadJsonFile,
  writeJsonFile,
  MODELS_CONFIG_PATH,
  GLOBAL_CONFIG_PATH,
  DEFAULT_GLOBAL_CONFIG,
} from '../utils/config-utils'
import type { GlobalConfig, LLMFinishReason, LLMRequest, ModelDiscoveryRequest, ModelProfile, TokenUsage } from '../../src/shared/ipc-channels'
import { isProjectSessionContext } from '../../src/shared/project-session-context'
import { resolveGenerationParameters, type ResolvedGenerationParameters } from '../llm/generation-parameter-policy'
import { getCurrentProjectPath } from '../database'
import { LLMHistoryRepository } from '../repositories/llm-repository'
import { projectAccess } from '../services/project-access'
import { ModelDiscoveryService } from '../services/model-discovery-service'
import { isSubmitToolName } from '../../src/shared/submit-contract'
import { assertGenerationModelSupportsTools } from '../../src/shared/tool-calling-gate'
import { logFailure } from '../../src/shared/fail-log'
import { SingleShotAbortedError, streamSingleShot, type StreamSingleShotOptions } from '../pi/pi-single-shot'
import { patchGoogleSamplingPayload, toPiSamplingParams } from '../pi/pi-stream-options'
import { createSubmitTool, visibleTextFromSubmitArtifact } from '../pi/submit-tools'

import { normalizeModelProfiles } from '../../src/shared/model-profile'

interface ActiveStream {
  controller: AbortController
  recordCancelled: () => void
}

const activeStreams = new Map<string, ActiveStream>()
const CONNECTION_TEST_MAX_TOKENS = 1024

function loadModelConfigs(): ModelProfile[] {
  return normalizeModelProfiles(readJsonFile<unknown[]>(MODELS_CONFIG_PATH, []))
}

function loadModelConfigsForUpdate(): ModelProfile[] {
  const result = tryReadJsonFile<unknown>(MODELS_CONFIG_PATH)
  if (result.status === 'error') {
    throw new Error('模型配置损坏，已拒绝覆盖', { cause: result.error })
  }
  return result.status === 'ok' ? normalizeModelProfiles(result.value) : []
}

function loadGlobalConfigForUpdate(): GlobalConfig {
  const result = tryReadJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH)
  if (result.status === 'error') {
    throw new Error('全局配置损坏，已拒绝覆盖', { cause: result.error })
  }
  return result.status === 'ok' ? result.value : { ...DEFAULT_GLOBAL_CONFIG }
}

function saveModelConfigs(models: ModelProfile[]) {
  writeJsonFile(MODELS_CONFIG_PATH, normalizeModelProfiles(models))
}

function getModelConfig(modelId: string): ModelProfile | null {
  const models = loadModelConfigs()
  return models.find((m) => m.id === modelId) ?? null
}

function resolveSubmitToolName(request: Pick<LLMRequest, 'submitTool'>) {
  return isSubmitToolName(request.submitTool) ? request.submitTool : 'submit_text'
}

function toStreamSingleShotOptions(
  model: ModelProfile,
  params: ResolvedGenerationParameters,
  extra: Pick<StreamSingleShotOptions, 'signal' | 'inFlightId' | 'onDelta'> = {},
): StreamSingleShotOptions {
  return {
    ...extra,
    maxTokens: params.maxTokens,
    temperature: params.temperature,
    samplingParams: toPiSamplingParams(params),
    // Gemini 适配器不读 samplingParams，温度与思考预算只能打进请求体。
    ...(model.protocol === 'gemini'
      ? { payloadPatch: (payload: unknown) => patchGoogleSamplingPayload(payload, params) }
      : {}),
  }
}

async function completeSingleShot(
  model: ModelProfile,
  request: Pick<LLMRequest, 'messages' | 'submitTool'>,
  params: ResolvedGenerationParameters,
  extra?: Pick<StreamSingleShotOptions, 'signal' | 'inFlightId' | 'onDelta'>,
) {
  assertGenerationModelSupportsTools(model)
  const submitTool = resolveSubmitToolName(request)
  const systemPrompt = request.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
  const nonSystem = request.messages.filter(m => m.role !== 'system')
  const userPrompt = nonSystem.length === 1 && nonSystem[0].role === 'user'
    ? nonSystem[0].content
    : nonSystem.map(m => m.role === 'assistant' ? `Assistant:\n${m.content}` : m.content).join('\n\n')
  const result = await streamSingleShot(
    model,
    systemPrompt,
    userPrompt,
    createSubmitTool(submitTool),
    toStreamSingleShotOptions(model, params, extra),
  )
  const content = visibleTextFromSubmitArtifact(submitTool, result.artifact, result.text)
  const finishReason = result.finishReason
  const success = finishReason === 'stop'
  return {
    success,
    content,
    artifact: result.artifact,
    finishReason,
    error: success ? undefined : `finish:${finishReason}`,
  }
}

function applyProxyConfig() {
  try {
    const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
    if (config.proxy?.enabled && config.proxy.host) {
      const proxyUrl = config.proxy.type === 'socks5'
        ? `socks5://${config.proxy.host}:${config.proxy.port}`
        : `http://${config.proxy.host}:${config.proxy.port}`
      process.env.HTTP_PROXY = proxyUrl
      process.env.HTTPS_PROXY = proxyUrl
      process.env.http_proxy = proxyUrl
      process.env.https_proxy = proxyUrl
    } else {
      delete process.env.HTTP_PROXY
      delete process.env.HTTPS_PROXY
      delete process.env.http_proxy
      delete process.env.https_proxy
    }
  } catch (error) {
    logFailure('LLM', 'apply proxy config failed', error)
  }
}

function recordProviderOutcome(
  request: LLMRequest,
  model: ModelProfile,
  startedAt: number,
  outcome: {
    success: boolean
    usage?: TokenUsage
    error?: string
    finishReason?: LLMFinishReason
  },
): void {
  if (!isProjectSessionContext(request.projectSession)) return
  try {
    projectAccess.assertCurrentProjectContext(request.projectSession, getCurrentProjectPath())
    LLMHistoryRepository.logCall({
      modelId: model.id,
      modelName: model.name || model.modelName,
      purpose: request.purpose?.trim() || 'generation',
      promptTokens: outcome.usage?.promptTokens ?? null,
      completionTokens: outcome.usage?.completionTokens ?? null,
      totalTokens: outcome.usage?.totalTokens ?? null,
      durationMs: Math.max(0, Date.now() - startedAt),
      success: outcome.success,
      errorMessage: outcome.finishReason && outcome.finishReason !== 'stop'
        ? `finish:${outcome.finishReason}`
        : outcome.error,
    })
  } catch (error) {
    // Statistics are diagnostic only and must never change generation outcome.
    console.warn('[AI Novel Writer] LLM call statistics were not recorded.', error)
  }
}

export function registerLLMController() {
  const modelDiscovery = new ModelDiscoveryService()

  ipcMain.handle('llm:generate-stream', async (event, requestId: string, request: LLMRequest) => {
    applyProxyConfig()
    const model = getModelConfig(request.modelId)
    if (!model) return { requestId, started: false, error: '指定的生成模型不存在或已被删除。' }
    const generationParameters = resolveGenerationParameters(model, request)

    const abortController = new AbortController()
    const startedAt = Date.now()
    let recorded = false
    const recordOnce = (outcome: { success: boolean; usage?: TokenUsage; error?: string; finishReason?: LLMFinishReason }) => {
      if (recorded) return
      recorded = true
      recordProviderOutcome(request, model, startedAt, outcome)
    }
    activeStreams.set(requestId, {
      controller: abortController,
      recordCancelled: () => recordOnce({ success: false, error: 'cancelled' }),
    })
    const win = BrowserWindow.fromWebContents(event.sender)

    void completeSingleShot(
      model,
      request,
      generationParameters,
      {
        signal: abortController.signal,
        inFlightId: `llm:${requestId}`,
        onDelta: (chunk: string) => {
          win?.webContents.send('llm:stream-chunk', { requestId, chunk })
        },
      },
    ).then(result => {
      recordOnce({ success: result.success, error: result.error, finishReason: result.finishReason })
      win?.webContents.send('llm:stream-done', {
        requestId,
        fullText: result.content,
        artifact: result.artifact,
        finishReason: result.finishReason,
      })
    }).catch(error => {
      if (error instanceof SingleShotAbortedError || abortController.signal.aborted) {
        recordOnce({ success: false, error: 'cancelled' })
        win?.webContents.send('llm:stream-error', { requestId, error: 'cancelled' })
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      recordOnce({ success: false, error: message })
      win?.webContents.send('llm:stream-error', { requestId, error: message })
    }).finally(() => {
      activeStreams.delete(requestId)
    })
    return { requestId, started: true }
  })

  ipcMain.handle('llm:cancel', async (_event, requestId: string) => {
    const stream = activeStreams.get(requestId)
    if (stream) {
      stream.recordCancelled()
      stream.controller.abort()
      activeStreams.delete(requestId)
      return { success: true }
    }
    return { success: false }
  })

  ipcMain.handle('llm:list-models', async () => loadModelConfigs())

  ipcMain.handle('llm:discover-models', async (_event, request: ModelDiscoveryRequest) => {
    try {
      applyProxyConfig()
      return await modelDiscovery.discoverModels(request)
    } catch (error) {
      logFailure('LLM', 'discover-models failed', error)
      return { success: false, errorCode: 'invalid_response' as const }
    }
  })

  ipcMain.handle('llm:save-model', async (_event, model: ModelProfile) => {
    try {
      const models = loadModelConfigsForUpdate()
      const idx = models.findIndex((m) => m.id === model.id)
      if (idx >= 0) models[idx] = model
      else models.push(model)
      saveModelConfigs(models)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('llm:delete-model', async (_event, modelId: string) => {
    let originalConfig: GlobalConfig | undefined
    let configChanged = false
    try {
      const modelsRead = tryReadJsonFile<ModelProfile[]>(MODELS_CONFIG_PATH)
      if (modelsRead.status === 'error') throw modelsRead.error
      const originalModels = modelsRead.status === 'ok' ? modelsRead.value : []
      const configRead = tryReadJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH)
      if (configRead.status === 'error') throw configRead.error
      originalConfig = configRead.status === 'ok'
        ? configRead.value
        : { ...DEFAULT_GLOBAL_CONFIG }

      const nextConfig = { ...originalConfig }
      if (nextConfig.defaultModelId === modelId) {
        nextConfig.defaultModelId = null
        configChanged = true
      }
      if (nextConfig.defaultEmbeddingModelId === modelId) {
        nextConfig.defaultEmbeddingModelId = null
        configChanged = true
      }

      // 先清除引用，再删除被引用对象。若第二个文件写入失败，回滚配置；
      // 即使回滚也失败，配置中只会缺少默认值，不会悬空指向已删除模型。
      if (configChanged) writeJsonFile(GLOBAL_CONFIG_PATH, nextConfig)
      try {
        saveModelConfigs(originalModels.filter(model => model.id !== modelId))
      } catch (error) {
        if (configChanged) {
          try {
            writeJsonFile(GLOBAL_CONFIG_PATH, originalConfig)
          } catch (rollbackError) {
            throw new Error(`${String(error)}；恢复默认模型配置失败：${String(rollbackError)}`)
          }
        }
        throw error
      }
      return {
        success: true,
        defaultModelId: nextConfig.defaultModelId,
        defaultEmbeddingModelId: nextConfig.defaultEmbeddingModelId ?? null,
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('llm:set-default-model', async (_event, modelId: string | null) => {
    try {
      const config = loadGlobalConfigForUpdate()
      config.defaultModelId = modelId
      writeJsonFile(GLOBAL_CONFIG_PATH, config)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('llm:get-default-model', async () => {
    const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
    return config.defaultModelId
  })

  ipcMain.handle('llm:set-default-embedding-model', async (_event, modelId: string | null) => {
    try {
      const config = loadGlobalConfigForUpdate()
      config.defaultEmbeddingModelId = modelId
      writeJsonFile(GLOBAL_CONFIG_PATH, config)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('llm:get-default-embedding-model', async () => {
    const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
    return config.defaultEmbeddingModelId ?? null
  })

  ipcMain.handle('llm:test-connection', async (
    _event,
    model: ModelProfile,
    creativeStrategy: LLMRequest['creativeStrategy'] = 'auto',
  ) => {
    try {
      applyProxyConfig()

      let result = { success: true, error: undefined as undefined | string }
      if (model.purposes?.includes('embedding')) {
        const { generateEmbeddings } = await import('../embedding')
        await generateEmbeddings(['hello'], model.protocol, model)
      } else {
        const res = await completeSingleShot(
          model,
          { messages: [{ role: 'user', content: 'Say "hello" and nothing else.' }] },
          resolveGenerationParameters(model, {
            // 推理模型可能先消耗 reasoning tokens；预算过小会把可用连接误判为截断失败。
            maxTokens: CONNECTION_TEST_MAX_TOKENS,
            reasoningStage: 'general',
            creativeStrategy,
          }),
        )
        result = { success: res.success, error: res.error }
      }
      
      return { success: result.success, error: result.error }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
}
