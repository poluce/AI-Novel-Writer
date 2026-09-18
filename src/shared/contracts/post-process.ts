export interface PostProcessRunData {
  id: string
  triggerSourceType: string
  triggerSourceId: string
  sourceLabel: string
  allCriticalPassed: boolean
  createdAt: string
  updatedAt: string
}

export interface PostProcessStepData {
  id: number
  runId: string
  stepKey: string
  label: string
  critical: boolean
  ok: boolean
  errorMsg: string
  attemptCount: number
  completedAt: string
  lastAttemptAt: string
}
