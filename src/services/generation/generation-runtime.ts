import type {
  CreationTaskKey,
  ModelProfile,
  ProjectSessionContext,
} from '../../shared/ipc-channels'
import type { CreativeStrategy, GenerationReasoningStage } from '../../shared/reasoning-types'
import type { SubmitToolName } from '../../shared/submit-contract'
import { projectSessionContextFromProject } from '../../shared/project-session-context'
import { useLLMStore } from '../../stores/llm-store'
import { useProjectStore } from '../../stores/project-store'
import { logFailure } from '../../shared/fail-log'
import {
  assertGenerationHarnessPolicy,
  createGenerationHarness,
  type GenerationHarnessPolicy,
  type GenerationMessage,
  type GenerationSession,
  type PhysicalGenerationPlan,
  type ProviderCompletion,
} from './generation-harness'

export type GenerationRuntimeBudget = GenerationHarnessPolicy

export interface GenerationCompletionRequest {
  modelId: string
  projectSession?: ProjectSessionContext
  purpose: string
  creativeStrategy: CreativeStrategy
  reasoningStage: GenerationReasoningStage
  taskKey?: CreationTaskKey
  messages: readonly GenerationMessage[]
  plan: Readonly<PhysicalGenerationPlan>
  signal: AbortSignal
  submitTool?: SubmitToolName
}

/** Renderer adapter for the authoritative main-process model lease seam. */
export interface GenerationRuntimeEnvironment {
  snapshotDefaultModelId(taskKey?: CreationTaskKey): string | null
  snapshotCreativeStrategy?(): CreativeStrategy
  snapshotModel?(modelId: string): ModelProfile | null
  complete(request: GenerationCompletionRequest): Promise<ProviderCompletion>
}

export interface GenerationRuntimeScope {
  session: GenerationSession
}

export interface GenerationRuntime {
  execute<T>(operation: (scope: GenerationRuntimeScope) => Promise<T>): Promise<T>
  close(): Promise<void>
}

export interface CreateGenerationRuntimeOptions {
  budget: GenerationRuntimeBudget
  /** Optional semantic model identity; omitted means snapshot the renderer default once. */
  modelId?: string
  /** Optional creation task key to route stage-specific models. */
  taskKey?: CreationTaskKey
  /** Project identity captured by the caller before any asynchronous lease work. */
  projectSession?: ProjectSessionContext
  /** Project writing policy captured by the caller before asynchronous preparation. */
  creativeStrategy?: CreativeStrategy
  /** Alternate physical budget inputs are forbidden; one budget owns both consumers. */
  policy?: never
  structuredLimits?: never
}

export class GenerationRuntimeError extends Error {
  constructor(
    readonly code:
      | 'NO_DEFAULT_MODEL'
      | 'MODEL_NOT_FOUND'
      | 'INVALID_BUDGET_SOURCE'
      | 'RUNTIME_CLOSED',
    message: string,
  ) {
    super(message)
    this.name = 'GenerationRuntimeError'
  }
}

function publicModelRevision(model: ModelProfile): string {
  return [
    model.id,
    model.provider,
    model.protocol,
    model.modelName,
    model.baseUrl,
    String(model.maxTokens ?? ''),
  ].join('\u0000')
}

function createDefaultEnvironment(): GenerationRuntimeEnvironment {
  return {
    snapshotDefaultModelId: (taskKey?: CreationTaskKey) => {
      const store = useLLMStore.getState()
      if (taskKey) {
        const candidate = store.resolveTaskModelId(taskKey)
        if (candidate) return candidate
      }
      return store.defaultModelId
        ?? store.models.find(m => m.purposes?.includes('generation'))?.id
        ?? null
    },
    snapshotCreativeStrategy: () => (
      useProjectStore.getState().currentProject?.novelConfig.creativeStrategy ?? 'auto'
    ),
    snapshotModel: (modelId) => (
      useLLMStore.getState().models.find(model => model.id === modelId) ?? null
    ),
    complete(request) {
      const llmStore = useLLMStore.getState()
      return new Promise<ProviderCompletion>((resolve, reject) => {
        let requestId: string | null = null
        let settled = false
        const cleanup = () => request.signal.removeEventListener('abort', cancel)
        const succeed = (completion: ProviderCompletion) => {
          if (settled) return
          settled = true
          cleanup()
          resolve(completion)
        }
        const fail = (error?: unknown) => {
          if (settled) return
          settled = true
          cleanup()
          logFailure('Generation', 'stream failed', error, {
            purpose: request.purpose,
            modelId: request.modelId,
          })
          reject(new Error('模型请求失败'))
        }
        const cancel = () => {
          if (requestId) {
            llmStore.cancelGeneration(requestId).catch((cancelError) => {
              logFailure('Generation', 'cancel stream failed', cancelError, {
                purpose: request.purpose,
                requestId,
              })
            })
          }
          fail(request.signal.reason ?? new Error('aborted'))
        }
        request.signal.addEventListener('abort', cancel, { once: true })
        if (request.signal.aborted) {
          cancel()
          return
        }

        const effectiveTaskKey = request.taskKey
          ?? (request.reasoningStage === 'drafting' ? 'drafting'
              : request.reasoningStage === 'review' ? 'review'
              : request.reasoningStage === 'general' ? 'assistant'
              : request.purpose.includes('field') || request.purpose.includes('core-seed') || request.purpose.includes('world-building') ? 'outline'
              : 'planning')

        llmStore.generateStream(
          [...request.messages],
          {
            onDone: (content, usage, finishReason, artifact) => succeed({ content, usage, finishReason, artifact }),
            onError: fail,
          },
          request.modelId,
          {
            projectSession: request.projectSession,
            purpose: request.purpose,
            creativeStrategy: request.creativeStrategy,
            reasoningStage: request.reasoningStage,
            taskKey: effectiveTaskKey,
            maxTokens: request.plan.maxOutputTokens,
            responseFormat: request.plan.responseFormat,
            ...(request.submitTool ? { submitTool: request.submitTool } : {}),
          },
        ).then(id => {
          requestId = id
          if (request.signal.aborted) cancel()
        }).catch(fail)
      })
    },
  }
}

function freezeBudget(budget: GenerationRuntimeBudget): Readonly<GenerationRuntimeBudget> {
  return Object.freeze({ ...budget })
}

/** 一次生成运行：按当前模型 id 现查档案，不再签发执行租约。 */
export async function createGenerationRuntime(
  options: CreateGenerationRuntimeOptions,
  environment: GenerationRuntimeEnvironment = createDefaultEnvironment(),
): Promise<GenerationRuntime> {
  if ('policy' in options || 'structuredLimits' in options) {
    throw new GenerationRuntimeError(
      'INVALID_BUDGET_SOURCE',
      '生成运行时只能接受一个共享 budget。',
    )
  }
  const budget = freezeBudget(options.budget)
  const sessionCandidate = options.projectSession
    ?? projectSessionContextFromProject(useProjectStore.getState().currentProject)
  const projectSession = sessionCandidate
    ? Object.freeze({ ...sessionCandidate })
    : undefined
  assertGenerationHarnessPolicy(budget)
  const explicitModelId = options.modelId?.trim()
  if (Object.hasOwn(options, 'modelId') && !explicitModelId) {
    throw new GenerationRuntimeError('MODEL_NOT_FOUND', '指定的生成模型不存在或已被删除。')
  }
  const frozenCreativeStrategy = options.creativeStrategy
    ?? environment.snapshotCreativeStrategy?.()
    ?? 'auto'

  const resolveModelId = () => {
    const modelId = explicitModelId ?? environment.snapshotDefaultModelId(options.taskKey)
    if (!modelId) {
      throw new GenerationRuntimeError('NO_DEFAULT_MODEL', '未配置默认生成模型。')
    }
    return modelId
  }

  const harness = createGenerationHarness({
    modelSource: {
      snapshotDefaultModel: () => {
        const modelId = resolveModelId()
        const model = environment.snapshotModel?.(modelId)
        if (!model) return null
        return {
          revision: publicModelRevision(model),
          model: {
            id: model.id,
            provider: model.provider,
            protocol: model.protocol,
            modelName: model.modelName,
            baseUrl: model.baseUrl,
            maxTokens: model.maxTokens,
            capabilities: model.capabilities,
          },
        }
      },
    },
    completionPort: {
      complete(request) {
        return environment.complete({
          modelId: request.modelId,
          projectSession,
          purpose: request.purpose,
          creativeStrategy: request.creativeStrategy,
          reasoningStage: request.reasoningStage,
          messages: request.messages,
          plan: request.plan,
          signal: request.signal,
          ...(request.submitTool ? { submitTool: request.submitTool } : {}),
        })
      },
    },
    policy: budget,
    creativeStrategy: frozenCreativeStrategy,
  })

  let closed = false
  const close = async () => { closed = true }

  return {
    async execute<T>(operation: (scope: GenerationRuntimeScope) => Promise<T>): Promise<T> {
      if (closed) throw new GenerationRuntimeError('RUNTIME_CLOSED', '模型生成运行时已关闭。')
      resolveModelId()
      const session = harness.openSession()
      return operation({ session })
    },
    close,
  }
}
