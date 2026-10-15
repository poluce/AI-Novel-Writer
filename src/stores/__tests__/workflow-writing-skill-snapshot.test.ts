import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useLocaleStore } from '../locale-store'
import { useProjectStore } from '../project-store'
import { useWorkflowStore, type WorkflowContext } from '../workflow-store'

const projectPath = 'C:\\novels\\skill-snapshot'
const projectSession = {
  projectId: 'skill-snapshot',
  projectPath,
}

beforeEach(() => {
  useWorkflowStore.setState({
    activeRuns: [], history: [], globalLogs: [], waitingRuns: {}, currentRun: null,
    waitingForConfirm: false, waitingAfterStepIndex: -1,
  })
  useProjectStore.setState({
    currentProject: {
      id: projectSession.projectId,
      name: 'Skill snapshot',
      path: projectPath,
      novelConfig: { writingLanguage: 'en-US' },
    } as never,
  })
  useLocaleStore.setState({ locale: 'en-US', initialized: true })
})

describe('workflow start without stage-bound skills', () => {
  it('starts and runs steps without injecting writing skills', async () => {
    const contexts: WorkflowContext[] = []

    await useWorkflowStore.getState().startWorkflow({
      type: 'chapter_creation',
      title: 'On-demand skill workflow',
      projectPath,
      projectSession,
      steps: [
        { name: 'one', description: 'one', executor: async (_step, context) => { contexts.push(context) } },
        { name: 'two', description: 'two', executor: async (_step, context) => { contexts.push(context) } },
      ],
    })

    expect(contexts).toHaveLength(2)
    expect(contexts[0]).toBe(contexts[1])
    expect('writingSkills' in contexts[0]).toBe(false)
    expect(useWorkflowStore.getState().history[0]).toMatchObject({
      title: 'On-demand skill workflow',
      status: 'completed',
    })
    expect(useWorkflowStore.getState().history[0]).not.toHaveProperty('writingSkills')
  })

  it('reserves resource claims before a duplicate writer can start', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const firstExecutor = vi.fn(async () => { await firstGate })
    const duplicateExecutor = vi.fn().mockResolvedValue(undefined)

    const firstCompletion = useWorkflowStore.getState().startWorkflow({
      type: 'chapter_creation',
      title: 'First chapter writer',
      projectPath,
      projectSession,
      resourceKeys: ['chapter:1'],
      steps: [{ name: 'write', description: 'write', executor: firstExecutor }],
    })
    expect(useWorkflowStore.getState().activeRuns).toHaveLength(1)

    await useWorkflowStore.getState().startWorkflow({
      type: 'chapter_creation',
      title: 'Duplicate chapter writer',
      projectPath,
      projectSession,
      resourceKeys: ['chapter:1'],
      steps: [{ name: 'write', description: 'write', executor: duplicateExecutor }],
    })

    expect(duplicateExecutor).not.toHaveBeenCalled()
    expect(useWorkflowStore.getState().history[0]).toMatchObject({
      title: 'Duplicate chapter writer',
      status: 'failed',
    })

    releaseFirst()
    await firstCompletion
    expect(firstExecutor).toHaveBeenCalledOnce()
  })
})
