/**
 * 嵌入模型配置解析 —— 知识库控制器与 search_knowledge 工具共用一份实现。
 *
 * 走全局设置里的默认嵌入模型（未配置时回落到默认对话模型），
 * 返回调用方直接可用的协议与连接信息。
 */

import {
  readJsonFile,
  GLOBAL_CONFIG_PATH,
  DEFAULT_GLOBAL_CONFIG,
  MODELS_CONFIG_PATH,
} from '../utils/config-utils'
import type { GlobalConfig, ModelProfile } from '../../src/shared/ipc-channels'
import type { EmbeddingOptions } from '../../src/shared/embedding-options'

export interface EmbeddingConfig {
  protocol: 'openai' | 'gemini'
  model: {
    baseUrl: string
    apiKey: string
    modelName: string
    embeddingOptions?: EmbeddingOptions
  }
}

export function getEmbeddingConfig(): EmbeddingConfig | null {
  const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
  const targetModelId = config.defaultEmbeddingModelId || config.defaultModelId
  if (!targetModelId) return null

  const models = readJsonFile<ModelProfile[]>(MODELS_CONFIG_PATH, [])
  const model = models.find(candidate => candidate.id === targetModelId)
  if (!model) return null
  return {
    protocol: model.protocol as 'openai' | 'gemini',
    model: {
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
      modelName: model.modelName,
      embeddingOptions: model.embeddingOptions,
    },
  }
}

/** 配置存在且连接信息可用（endpoint 与 key 都非空）。 */
export function hasUsableEmbeddingConfig(
  config: EmbeddingConfig | null,
): config is EmbeddingConfig {
  return !!config && !!config.model.baseUrl.trim() && !!config.model.apiKey.trim()
}
