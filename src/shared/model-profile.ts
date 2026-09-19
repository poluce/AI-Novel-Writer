import type { ModelProfile } from './ipc-channels'
import { REASONING_EFFORTS, type ReasoningOverride } from './reasoning-types'

/**
 * 权威模型档案归一化函数：
 * 保证流入系统（前端 Store、主进程控制器、Agent 运行时）的所有 ModelProfile 实例
 * 均满足强类型契约，从数据源头彻底消除字段缺失引发的崩溃与白屏。
 */
export function normalizeModelProfile(raw: unknown): ModelProfile {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : 'unknown'
  const modelName = typeof obj.modelName === 'string'
    ? obj.modelName.trim()
    : (typeof obj.name === 'string' ? obj.name.trim() : '')
  const name = typeof obj.name === 'string' && obj.name.trim()
    ? obj.name.trim()
    : (modelName || 'Unnamed Model')
  const channelName = typeof obj.channelName === 'string' && obj.channelName.trim()
    ? obj.channelName.trim()
    : undefined

  // 兼容老配置中历史服务商标识（如 google -> gemini）
  let provider = typeof obj.provider === 'string' ? obj.provider.toLowerCase() : 'custom'
  if (provider === 'google') provider = 'gemini'
  const validProviders = new Set([
    'openai',
    'gemini',
    'deepseek',
    'ollama',
    'bigmodel',
    'xai',
    'siliconflow',
    'custom',
  ])
  const finalProvider = (validProviders.has(provider) ? provider : 'custom') as ModelProfile['provider']

  let protocol: ModelProfile['protocol'] = finalProvider === 'gemini' ? 'gemini' : 'openai'
  if (obj.protocol === 'gemini' || obj.protocol === 'openai') {
    protocol = obj.protocol
  }

  const apiKey = typeof obj.apiKey === 'string' ? obj.apiKey : ''
  const baseUrl = typeof obj.baseUrl === 'string' ? obj.baseUrl : ''
  const temperature = typeof obj.temperature === 'number' && Number.isFinite(obj.temperature)
    ? obj.temperature
    : 0.7
  const maxTokens = typeof obj.maxTokens === 'number' && Number.isFinite(obj.maxTokens) && obj.maxTokens > 0
    ? obj.maxTokens
    : 4096

  // 归一化用途 (purposes)
  const allowedPurposes = new Set(['generation', 'refinement', 'summary', 'embedding'] as const)
  const rawPurposes = Array.isArray(obj.purposes) ? obj.purposes : []
  const filteredPurposes = rawPurposes.filter((p): p is ModelProfile['purposes'][number] =>
    allowedPurposes.has(p as never),
  )

  let purposes: ModelProfile['purposes']
  if (filteredPurposes.length > 0) {
    purposes = filteredPurposes
  } else {
    // 语义启发兜底：若模型名明确包含 embedding 或 bge，则归入 embedding，否则默认为生成套件
    const lowerName = `${modelName} ${name}`.toLowerCase()
    if (lowerName.includes('embedding') || lowerName.includes('bge')) {
      purposes = ['embedding']
    } else {
      purposes = ['generation', 'refinement', 'summary']
    }
  }

  return {
    id,
    name,
    channelName,
    provider: finalProvider,
    protocol,
    modelName,
    apiKey,
    baseUrl,
    temperature,
    maxTokens,
    purposes,
    capabilities: (obj.capabilities && typeof obj.capabilities === 'object') ? obj.capabilities as never : undefined,
    reasoningOverride: (obj.reasoningOverride === 'auto' || (typeof obj.reasoningOverride === 'string' && (REASONING_EFFORTS as readonly string[]).includes(obj.reasoningOverride)))
      ? obj.reasoningOverride as ReasoningOverride
      : undefined,
    embeddingOptions: (obj.embeddingOptions && typeof obj.embeddingOptions === 'object') ? obj.embeddingOptions as never : undefined,
  }
}

export function normalizeModelProfiles(rawList: unknown): ModelProfile[] {
  if (!Array.isArray(rawList)) return []
  return rawList.map(normalizeModelProfile)
}
