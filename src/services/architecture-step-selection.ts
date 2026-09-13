/**
 * 故事架构（前提 / 角色图谱 / 世界观）的步骤选择。
 *
 * 情节大纲已从故事架构中拆出为并列的一级页面，因此不在这里的可选步骤内。
 */
export type ArchStepKey = 'premise' | 'characters' | 'worldbuilding'

const ARCH_STEP_ORDER: ArchStepKey[] = ['premise', 'characters', 'worldbuilding']

export function createDefaultArchitectureSelection(
  archStatus: Record<string, boolean>,
  initialSelectedSteps?: ArchStepKey[],
): Record<ArchStepKey, boolean> {
  const selected = new Set<ArchStepKey>()

  for (const step of ARCH_STEP_ORDER) {
    if (!archStatus[step]) selected.add(step)
  }

  if (initialSelectedSteps) {
    for (const step of initialSelectedSteps) {
      selected.add(step)
    }
  }

  return {
    premise: selected.has('premise'),
    characters: selected.has('characters'),
    worldbuilding: selected.has('worldbuilding'),
  }
}
