import { describe, expect, it, vi } from 'vitest'
import type { GenerationSession, GenerationTask } from '../../../generation/generation-harness'
import type { CommandExecuteParams, WorkflowGenerationRuntimeDependencies } from '../base-command'

describe('BaseWorkflowCommand writing skill injection', () => {
  it('does not inject a writing skill from reasoning stage or context', async () => {
    const complete = vi.fn(async (task: GenerationTask) => {
      expect(task.purpose).toBe('workflow')
      return {
        content: 'analysis',
        finishReason: 'stop' as const,
        budget: {} as never,
        receipt: {
          model: {} as never,
          capabilities: {} as never,
          budget: {} as never,
          finishReason: 'stop' as const,
        },
      }
    })
    const session = { budget: {}, complete } as unknown as GenerationSession
    const dependencies: WorkflowGenerationRuntimeDependencies = {
      createRuntime: async () => ({
        execute: operation => operation({ session }),
        close: async () => {},
      }),
    }
    const { BaseWorkflowCommand } = await import('../base-command')
    class Probe extends BaseWorkflowCommand<string> {
      async execute(params: CommandExecuteParams) {
        return this.executeWithGenerationRuntime('text', params, () => this.callLLM(
          'ANALYZE STYLE',
          'SYSTEM',
          params.callbacks,
          { reasoningStage: 'review' },
          params.context,
        ))
      }
    }

    await new Probe(dependencies).execute({
      step: {},
      context: {
        runId: 'analysis-run', projectPath: 'C:/novels/project',
        projectSession: { projectId: 'project', projectPath: 'C:/novels/project' },
        writingLanguage: 'en-US', uiLocale: 'en-US', data: {}, cancelled: false,
      },
      callbacks: { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() },
    })

    expect(complete.mock.calls[0]?.[0].messages[1].content).toBe('ANALYZE STYLE')
    expect(complete.mock.calls[0]?.[0].promptBudget).toBeUndefined()
  })
})
