import { createHash } from 'node:crypto'

import { getBuiltinModel, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all'

import type {
  ModelExecutionCapabilityEvidenceSource,
  ModelExecutionLeaseReceipt,
  ModelProfile,
} from '../../src/shared/ipc-channels'
import {
  type ModelCapabilities,
  resolveModelProfileCapabilities,
} from '../../src/shared/provider-presets'

export class ModelExecutionLeaseError extends Error {
  constructor(
    readonly code: 'MODEL_NOT_FOUND' | 'INVALID_OUTPUT_CAPABILITY',
    message: string,
  ) {
    super(message)
    this.name = 'ModelExecutionLeaseError'
  }
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function normalizeEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  try {
    const endpoint = new URL(trimmed)
    endpoint.hash = ''
    endpoint.search = ''
    endpoint.pathname = endpoint.pathname.replace(/\/+$/u, '') || '/'
    return endpoint.toString().replace(/\/$/u, '')
  } catch {
    return trimmed.replace(/\/+$/u, '')
  }
}

function endpointSubject(model: ModelProfile) {
  return {
    provider: model.provider,
    protocol: model.protocol,
    endpoint: normalizeEndpoint(model.baseUrl),
  }
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null
}

/**
 * Query @earendil-works/pi-ai built-in model registry to resolve real capabilities
 * for models that may not be in the static local BUILTIN_PRESETS dictionary.
 */
export function resolvePiAiModelCapabilities(
  modelName: string,
  provider?: string,
): ModelCapabilities | undefined {
  const trimmed = modelName.trim()
  if (!trimmed) return undefined

  const queryModel = getBuiltinModel as (
    prov: string,
    id: string,
  ) => { contextWindow?: number; maxTokens?: number; reasoning?: boolean } | undefined

  // 1. Direct provider match if provider exists in Pi-AI
  let piModel = provider ? queryModel(provider, trimmed) : undefined

  // 2. Search all Pi-AI providers
  if (!piModel) {
    for (const p of getBuiltinProviders()) {
      const candidate = queryModel(p, trimmed)
      if (candidate) {
        piModel = candidate
        break
      }
    }
  }

  // 3. Search case-insensitive
  if (!piModel) {
    const lower = trimmed.toLowerCase()
    for (const p of getBuiltinProviders()) {
      const candidate = queryModel(p, lower)
      if (candidate) {
        piModel = candidate
        break
      }
    }
  }

  // 4. Match stripped prefix (e.g. openrouter/model or provider/model)
  if (!piModel && trimmed.includes('/')) {
    const slug = trimmed.split('/').pop()!
    for (const p of getBuiltinProviders()) {
      const candidate = queryModel(p, slug)
      if (candidate) {
        piModel = candidate
        break
      }
    }
  }

  if (!piModel) return undefined

  return {
    contextWindowTokens: piModel.contextWindow ?? null,
    maxOutputTokens: piModel.maxTokens ?? 4096,
    reasoning: piModel.reasoning ?? false,
    structuredOutput: true,
    usage: true,
    toolCalling: true,
  }
}

export function resolveModelExecutionCapabilityEvidence(
  model: ModelProfile,
): ModelExecutionLeaseReceipt['capabilityEvidence'] {
  const subjectFingerprint = sha256({
    ...endpointSubject(model),
    modelName: model.modelName,
  })
  const presetVerified = resolveModelProfileCapabilities(model)
  const piVerified = !presetVerified ? resolvePiAiModelCapabilities(model.modelName, model.provider) : undefined
  const verified = presetVerified ?? piVerified
  const verifiedSource: ModelExecutionCapabilityEvidenceSource = presetVerified
    ? 'verified-provider-preset'
    : (piVerified ? 'pi-ai-model-registry' : 'unknown')

  const explicitContextWindow = positiveInteger(model.capabilities?.contextWindowTokens)
  const explicitOutputCap = positiveInteger(model.capabilities?.maxOutputTokens)
  const legacyOutputCap = positiveInteger(model.maxTokens)
  const operationalOutputCap = explicitOutputCap ?? legacyOutputCap
  const verifiedOutputLimit = positiveInteger(verified?.maxOutputTokens)

  const hasInvalidExplicitOutput = model.capabilities?.maxOutputTokens !== undefined
    && model.capabilities.maxOutputTokens !== null
    && !positiveInteger(model.capabilities.maxOutputTokens)
  const hasInvalidLegacyOutput = model.maxTokens !== undefined
    && (Number.isNaN(model.maxTokens) || model.maxTokens <= 0)

  if (hasInvalidExplicitOutput || hasInvalidLegacyOutput) {
    throw new ModelExecutionLeaseError('INVALID_OUTPUT_CAPABILITY', '模型输出上限无效')
  }

  const unconstrainedOutputTokens = verifiedOutputLimit && operationalOutputCap
    ? Math.min(verifiedOutputLimit, operationalOutputCap)
    : verifiedOutputLimit ?? operationalOutputCap
  const contextWindowTokens = verified?.contextWindowTokens ?? explicitContextWindow
  const maxOutputTokens = unconstrainedOutputTokens && contextWindowTokens
    ? Math.min(unconstrainedOutputTokens, contextWindowTokens)
    : unconstrainedOutputTokens
  if (!maxOutputTokens) {
    throw new ModelExecutionLeaseError('INVALID_OUTPUT_CAPABILITY', '模型输出上限无效')
  }

  const maxOutputSource: ModelExecutionCapabilityEvidenceSource = verifiedOutputLimit === maxOutputTokens
    ? (verified ? verifiedSource : 'verified-provider-preset')
    : (explicitOutputCap
      ? 'user-operational-cap'
      : 'legacy-profile')

  return {
    source: {
      contextWindowTokens: verified
        ? verifiedSource
        : explicitContextWindow
          ? 'user-operational-cap'
          : 'unknown',
      maxOutputTokens: maxOutputSource,
      featureFlags: verified
        ? verifiedSource
        : model.capabilities
          ? 'user-operational-cap'
          : 'unknown',
    },
    subjectFingerprint,
    contextWindowTokens: contextWindowTokens ?? null,
    maxOutputTokens,
    reasoning: verified?.reasoning ?? (typeof model.capabilities?.reasoning === 'boolean' ? model.capabilities.reasoning : null),
    structuredOutput: verified?.structuredOutput ?? (typeof model.capabilities?.structuredOutput === 'boolean' ? model.capabilities.structuredOutput : null),
    usage: verified?.usage ?? (typeof model.capabilities?.usage === 'boolean' ? model.capabilities.usage : null),
  }
}

function modelRevision(model: ModelProfile): string {
  return sha256({
    id: model.id,
    ...endpointSubject(model),
    modelName: model.modelName,
    temperature: model.temperature,
    maxTokens: model.maxTokens,
    capabilities: model.capabilities ?? null,
    purposes: model.purposes,
    embeddingOptions: model.embeddingOptions ?? null,
  })
}

export interface CreateModelExecutionLeaseReceiptOptions {
  leaseId: string
  createdAt: number
  expiresAt: number
}

/**
 * Build the authoritative, secret-free execution receipt from one immutable
 * profile snapshot. The registry and in-process qualification adapter both use
 * this factory so capability planning cannot drift between execution seams.
 */
export function createModelExecutionLeaseReceipt(
  model: ModelProfile,
  options: CreateModelExecutionLeaseReceiptOptions,
): ModelExecutionLeaseReceipt {
  return {
    leaseId: options.leaseId,
    modelId: model.id,
    provider: model.provider,
    protocol: model.protocol,
    modelName: model.modelName,
    modelRevision: modelRevision(model),
    endpointFingerprint: sha256(endpointSubject(model)),
    capabilityEvidence: resolveModelExecutionCapabilityEvidence(model),
    createdAt: options.createdAt,
    expiresAt: options.expiresAt,
  }
}


