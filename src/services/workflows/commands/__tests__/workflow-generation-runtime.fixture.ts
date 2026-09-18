import { useLLMStore } from '../../../../stores/llm-store'
import type { ModelProfile } from '../../../../shared/ipc-channels'
import {
  createGenerationRuntime,
  type GenerationRuntimeEnvironment,
} from '../../../generation/generation-runtime'
import type { WorkflowGenerationRuntimeDependencies } from '../base-command'

function testModel(modelId: string): ModelProfile {
  return {
    id: modelId,
    name: modelId,
    provider: 'custom',
    protocol: 'openai',
    modelName: modelId,
    baseUrl: 'https://example.invalid',
    apiKey: '',
    maxTokens: 8192,
  } as ModelProfile
}

/** Creates a test adapter that preserves old stream doubles behind the public runtime seam. */
export function createWorkflowRuntimeDependencies(): WorkflowGenerationRuntimeDependencies {
  return {
    createRuntime(options) {
      const environment: GenerationRuntimeEnvironment = {
        snapshotDefaultModelId: () => useLLMStore.getState().defaultModelId ?? 'test-model',
        snapshotModel: (modelId) => testModel(modelId),
        complete: request => new Promise((resolve, reject) => {
          const store = useLLMStore.getState()
          store.generateStream(
            [...request.messages],
            {
              onDone: (content, usage, finishReason) => resolve({ content, usage, finishReason }),
              onError: error => reject(new Error(error)),
            },
            request.modelId,
            {
              purpose: request.purpose,
              creativeStrategy: request.creativeStrategy,
              reasoningStage: request.reasoningStage,
              maxTokens: request.plan.maxOutputTokens,
              responseFormat: request.plan.responseFormat,
              ...(request.submitTool ? { submitTool: request.submitTool } : {}),
            },
          ).catch(reject)
        }),
      }
      return createGenerationRuntime(options, environment)
    },
  }
}

/** Default test adapter for ordinary workflow-command fixtures. */
export const workflowRuntimeDependencies = createWorkflowRuntimeDependencies()
