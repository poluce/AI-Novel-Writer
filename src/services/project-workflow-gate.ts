import { confirm } from '../components/ui/Confirm'
import { sameProjectPathKey } from '../shared/project-session-context'
import { useLocaleStore } from '../stores/locale-store'

type ProjectLifecycleOperation = 'create' | 'open' | 'close'

/**
 * 开/关/建项目前的工作流门禁：确认后取消并等待该项目任务结束。
 * 不放进 project-store，避免 Store 编排另一家 Store。
 */
export async function confirmAndCancelProjectWorkflows(
  projectPath: string,
  operation: ProjectLifecycleOperation,
  shouldContinue: () => boolean = () => true,
): Promise<boolean> {
  const { useWorkflowStore } = await import('../stores/workflow-store')
  const text = useLocaleStore.getState().text
  const activeCount = useWorkflowStore.getState().activeRuns.filter(run => (
    sameProjectPathKey(run.projectPath, projectPath)
  )).length
  if (activeCount > 0) {
    const operationCopy = operation === 'create'
      ? { zh: '新建项目', en: 'create a project' }
      : operation === 'open'
        ? { zh: '打开其他项目', en: 'open another project' }
        : { zh: '关闭项目', en: 'close the project' }
    const approved = await confirm(
      text(
        `当前项目有 ${activeCount} 个创作任务。继续${operationCopy.zh}将取消并等待这些任务停止。`,
        `This project has ${activeCount} active creative task${activeCount === 1 ? '' : 's'}. Continuing to ${operationCopy.en} will cancel and wait for them to stop.`,
      ),
      {
        title: text('创作任务仍在运行', 'Creative tasks are still running'),
        confirmText: text('取消任务并继续', 'Cancel tasks and continue'),
        danger: true,
      },
    )
    if (!approved) return false
  }
  if (!shouldContinue()) return false
  await useWorkflowStore.getState().cancelProjectWorkflowsAndWait(projectPath)
  return shouldContinue()
}

export async function cancelProjectWorkflowsAndWait(projectPath: string): Promise<void> {
  const { useWorkflowStore } = await import('../stores/workflow-store')
  await useWorkflowStore.getState().cancelProjectWorkflowsAndWait(projectPath)
}
