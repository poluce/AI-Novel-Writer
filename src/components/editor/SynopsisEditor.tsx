import { useState, useEffect, useCallback, useRef } from 'react'
import { Map, AlertTriangle, CheckCircle2, Circle, RefreshCw, FileText } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useLocaleStore } from '../../stores/locale-store'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { toast } from '../ui/Toast'
import { ipc } from '../../services/ipc-client'
import { launchCreativeWorkflow } from '../../services/workflows/creative-workflow-launcher'
import { globalEventBus } from '../../shared/event-bus'
import {
  createProjectArchTabId,
  shouldRefreshArchOnWorkflowComplete,
  shouldSyncProjectArchTab,
} from './arch-file-refresh-policy'
import { LatestRequestGate } from './latest-request-gate'
import {
  captureProjectSession,
  isProjectSessionCurrent,
  isProjectSessionPath,
} from '../project-session-gate'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { sameProjectSessionContext } from '../../shared/project-session-context'
import {
  hasVisiblePartialSynopsisMarker,
  isRecoverableSynopsisCheckpoint,
  isUsableSynopsisCheckpoint,
} from '../../services/workflows/commands/architecture.command'

/** 续批按钮默认的每批章数上限（可在范围内调整，避免一次请求剩余全部章节）。 */
const CONTINUATION_BATCH_SPAN = 20

/** 情节大纲生成范围默认批量阈值：超过此章数时默认只生成首批。 */
const SCOPE_WARNING_THRESHOLD = 20

const SYNOPSIS_FILE_PATH = 'vela://core/synopsis'

/** 生成大纲所依赖的故事架构三块（用于「缺少权威输入」提示）。 */
type ArchInputKey = 'premise' | 'characters' | 'worldbuilding'

const ARCH_INPUT_LABELS: Record<ArchInputKey, [string, string]> = {
  premise: ['故事前提', 'story premise'],
  characters: ['角色图谱', 'character map'],
  worldbuilding: ['世界观', 'world building'],
}

type RangeResolution =
  | { ok: true; range?: { from: number; to: number } }
  | { ok: false }

/**
 * 情节大纲（与故事架构、小说配置、章节蓝图并列的一级页面）。
 *
 * 拥有自己的生成入口：全书/按章区间生成、断点续写、续批，以及完整文本视图。
 */
export default function SynopsisEditor({ projectKey }: { projectKey: string }) {
  const currentProject = useProjectStore(s => s.currentProject)
  const text = useLocaleStore(s => s.text)
  const projectMatches = currentProject?.path === projectKey
  const isArchRunning = useWorkflowStore(s => s.isTypeRunning('architecture_generation'))

  const [exists, setExists] = useState(false)
  const [wordCount, setWordCount] = useState(0)
  const [incomplete, setIncomplete] = useState(false)
  const [recoveryFailed, setRecoveryFailed] = useState(false)
  const [coveredTo, setCoveredTo] = useState(0)
  const [totalChapters, setTotalChapters] = useState(0)
  const [missingInputs, setMissingInputs] = useState<ArchInputKey[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [rangeFrom, setRangeFrom] = useState('')
  const [rangeTo, setRangeTo] = useState('')
  const lastCompletedRunRef = useRef<string | null>(null)
  const requestGate = useRef(new LatestRequestGate())

  const loadStatus = useCallback(async () => {
    await Promise.resolve()
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) {
      requestGate.current.begin()
      setExists(false)
      setWordCount(0)
      setIncomplete(false)
      setRecoveryFailed(false)
      setCoveredTo(0)
      setTotalChapters(0)
      setMissingInputs([])
      setLoading(false)
      return
    }
    const projectPath = projectSession.projectPath
    const requestId = requestGate.current.begin()
    setLoading(true)
    const [core, roster] = await Promise.all([
      ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', projectPath),
      ipc.invokeWithProjectSession(projectSession, 'db:character-roster-read', projectPath),
    ])
    const dbSynopsis = core?.synopsis || ''
    const total = Number(core?.totalChapters ?? currentProject?.novelConfig?.totalChapters) || 0
    const writingLanguage = (core?.writingLanguage ?? currentProject?.novelConfig?.writingLanguage) === 'en-US'
      ? 'en-US'
      : 'zh-CN'
    const visiblyPartial = hasVisiblePartialSynopsisMarker(dbSynopsis)

    let interrupted = false
    let failedRecovery = false
    let covered = 0
    try {
      const partialResult = await ipc.invokeWithProjectSession(
        projectSession,
        'fs:read-json',
        `${projectPath}/.vela/partial_arch.json`,
        projectPath,
      )
      const partial = partialResult?.success === true
        ? (partialResult as { data?: Record<string, unknown> }).data
        : undefined
      const checkpointUsable = isUsableSynopsisCheckpoint(partial, dbSynopsis, writingLanguage, total)
      interrupted = checkpointUsable && isRecoverableSynopsisCheckpoint(partial, dbSynopsis, writingLanguage, total)
      failedRecovery = visiblyPartial && !checkpointUsable
      covered = checkpointUsable && Number(partial?.synopsis_covered_to) > 0
        ? Number(partial?.synopsis_covered_to)
        : 0
    } catch {
      interrupted = false
      failedRecovery = visiblyPartial
      covered = 0
    }

    if (!requestGate.current.isLatest(requestId) || !isProjectSessionCurrent(projectSession)) return
    const generated = dbSynopsis.length > 50
    const missing: ArchInputKey[] = []
    if ((core?.premise?.length ?? 0) <= 50) missing.push('premise')
    if (roster?.status !== 'ready') missing.push('characters')
    if ((core?.worldbuilding?.length ?? 0) <= 50) missing.push('worldbuilding')
    setExists(generated)
    setWordCount(generated ? dbSynopsis.length : 0)
    setIncomplete(interrupted && generated)
    setRecoveryFailed(failedRecovery && generated)
    setCoveredTo(covered)
    setTotalChapters(total)
    setMissingInputs(generated ? [] : missing)
    setRangeFrom(current => current || (total > SCOPE_WARNING_THRESHOLD ? '1' : ''))
    setRangeTo(current => current || (total > SCOPE_WARNING_THRESHOLD ? String(SCOPE_WARNING_THRESHOLD) : ''))
    setLoading(false)
  }, [currentProject, projectKey, projectMatches])

  useEffect(() => {
    const timer = setTimeout(() => { void loadStatus() }, 0)
    return () => clearTimeout(timer)
  }, [loadStatus])

  useEffect(() => {
    const matches = (payload: { projectSession: ProjectSessionContext; runId: string }) => {
      const projectSession = captureProjectSession(currentProject)
      return !!projectSession
        && isProjectSessionCurrent(projectSession)
        && sameProjectSessionContext(projectSession, payload.projectSession)
    }
    const unsubUpdated = globalEventBus.on('ARCH_FILE_UPDATED', (payload) => {
      if (!matches(payload)) return
      void loadStatus()
    })
    const unsubComplete = globalEventBus.on('WORKFLOW_COMPLETE', (payload) => {
      const projectSession = captureProjectSession(currentProject)
      if (!projectSession || !isProjectSessionCurrent(projectSession)) return
      if (!shouldRefreshArchOnWorkflowComplete(payload, projectSession, lastCompletedRunRef.current)) return
      lastCompletedRunRef.current = payload.runId
      setBusy(false)
      void loadStatus()
    })
    return () => { unsubUpdated(); unsubComplete() }
  }, [currentProject, loadStatus])

  /** 解析本次生成范围：留空 = 1..total（全书）。 */
  const resolveRange = (): RangeResolution => {
    if (totalChapters <= 0) return { ok: true }
    const parseBound = (value: string): { empty: true } | { empty: false; value: number } | null => {
      if (!value.trim()) return { empty: true }
      const parsed = Number(value)
      return Number.isSafeInteger(parsed) && parsed > 0 ? { empty: false, value: parsed } : null
    }
    const parsedFrom = parseBound(rangeFrom)
    const parsedTo = parseBound(rangeTo)
    if (!parsedFrom || !parsedTo) return { ok: false }
    const from = parsedFrom.empty ? 1 : parsedFrom.value
    const to = parsedTo.empty ? totalChapters : parsedTo.value
    if (from > totalChapters || to > totalChapters || from > to) return { ok: false }
    return from === 1 && to === totalChapters ? { ok: true } : { ok: true, range: { from, to } }
  }

  const startGeneration = async (range?: { from: number; to: number }) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    if (!isProjectSessionCurrent(projectSession) || busy || isArchRunning) return
    setBusy(true)
    try {
      await launchCreativeWorkflow({
        workflow: 'generate_architecture',
        selectedSteps: ['synopsis'],
        ...(range ? { synopsisRange: range } : {}),
      }, projectSession)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      toast.error(text(`启动失败：${detail}`, `Failed to start: ${detail}`))
      if (isProjectSessionCurrent(projectSession)) setBusy(false)
    }
  }

  const handleGenerate = async () => {
    const resolution = resolveRange()
    if (!resolution.ok) {
      toast.error(text(
        `生成范围无效：应在第 1–${totalChapters} 章之间且起始章 ≤ 结束章。`,
        `Invalid range: it must stay within chapters 1-${totalChapters} with from ≤ to.`,
      ))
      return
    }
    await startGeneration(resolution.range)
  }

  const handleResume = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    if (!isProjectSessionCurrent(projectSession) || busy || isArchRunning) return
    setBusy(true)
    try {
      await launchCreativeWorkflow({
        workflow: 'generate_architecture',
        selectedSteps: ['synopsis'],
        resumeSynopsis: true,
      }, projectSession)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      toast.error(text(`续写启动失败：${detail}`, `Failed to start the continuation: ${detail}`))
      if (isProjectSessionCurrent(projectSession)) setBusy(false)
    }
  }

  const handleContinueBatch = async () => {
    const from = coveredTo + 1
    if (from > totalChapters || totalChapters <= 0) return
    const to = Math.min(totalChapters, from + CONTINUATION_BATCH_SPAN - 1)
    setRangeFrom(String(from))
    setRangeTo(String(to))
    await startGeneration({ from, to })
  }

  /** 打开情节大纲的完整文本视图（arch-file 标签页）。 */
  const openFullView = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    const { useEditorStore } = await import('../../stores/editor-store')
    const store = useEditorStore.getState()
    const tabId = createProjectArchTabId(projectKey, SYNOPSIS_FILE_PATH)
    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', projectSession.projectPath)
    if (!isProjectSessionCurrent(projectSession)) return
    const content = core?.synopsis || ''
    const existing = store.tabs.find(tab => tab.id === tabId)
    if (existing) {
      store.setActiveTab(tabId)
      if (shouldSyncProjectArchTab(existing, projectKey)) {
        store.syncTabContent(tabId, content)
        store.markTabSaved(tabId, content)
      }
      return
    }
    store.openFile({
      id: tabId,
      name: text('情节大纲', 'Plot outline'),
      type: 'arch-file',
      filePath: SYNOPSIS_FILE_PATH,
      content,
      savedContent: content,
      projectKey,
    })
  }

  if (!projectMatches) {
    return (
      <div className="h-full flex items-center justify-center">
        <EmptyState
          icon={<Map size={36} />}
          message={text('请先打开项目', 'Open a project to continue')}
          opacity={0.4}
        />
      </div>
    )
  }

  const statusTone = recoveryFailed
    ? 'var(--color-warning)'
    : exists
      ? 'var(--color-success)'
      : 'var(--color-border)'
  const pendingBatch = !incomplete && !recoveryFailed && coveredTo > 0 && coveredTo < totalChapters
  const disabled = loading || busy || isArchRunning

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div
        className="flex items-center justify-between gap-2 px-3 h-10 flex-shrink-0 border-b"
        style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-sidebar)' }}
      >
        <div className="flex items-center gap-1.5">
          <Map size={14} style={{ color: 'var(--color-text-muted)' }} />
          <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
            {text('情节大纲', 'Plot outline')}
          </span>
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {exists ? text('已生成', 'generated') : text('待生成', 'not generated')}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void loadStatus()}
            title={text('刷新状态', 'Refresh status')}
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </Button>
          <Button
            variant="ai"
            size="sm"
            onClick={() => void handleGenerate()}
            disabled={disabled}
            title={text('按下方范围生成情节大纲', 'Generate the plot outline for the range below')}
          >
            <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
            {exists ? text('AI 重新生成', 'Regenerate') : text('AI 生成大纲', 'Generate outline')}
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 py-4">
          <div
            className="rounded-lg border p-4 space-y-3"
            style={{ borderColor: statusTone, backgroundColor: 'var(--color-panel)' }}
          >
            <div className="flex items-center gap-2">
              {exists
                ? recoveryFailed
                  ? <AlertTriangle size={18} style={{ flexShrink: 0, color: 'var(--color-warning)' }} />
                  : <CheckCircle2 size={18} style={{ flexShrink: 0, color: 'var(--color-success)' }} />
                : <Circle size={18} style={{ flexShrink: 0, color: 'var(--color-text-muted)' }} />}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                  {text('全书情节大纲', 'Whole-book plot outline')}
                </div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                  {text(
                    '结构拐点 · 转折节奏 · 伏笔闭环；按章区间分批生成，已确认部分不会被覆盖。',
                    'Structural turning points, pacing, and setup/payoff; generated in chapter batches, confirmed content is never overwritten.',
                  )}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1 flex-shrink-0">
                {recoveryFailed ? (
                  <span className="text-[0.7rem] px-1.5 py-0.5 rounded font-medium bg-yellow-500/15 text-[var(--color-warning-text)]">
                    {text('不完整 · 检查点不可恢复', 'Incomplete · checkpoint unavailable')}
                  </span>
                ) : incomplete ? (
                  <span className="text-[0.7rem] px-1.5 py-0.5 rounded font-medium bg-yellow-500/15 text-[var(--color-warning-text)]">
                    {text('不完整 · 已存部分', 'Incomplete · partial saved')}
                  </span>
                ) : pendingBatch ? (
                  <span className="text-[0.7rem] px-1.5 py-0.5 rounded font-medium bg-yellow-500/15 text-[var(--color-warning-text)]">
                    {text(`已覆盖至第 ${coveredTo} 章 · 待续批`, `Covered to ch. ${coveredTo} · pending`)}
                  </span>
                ) : exists ? (
                  <span className="text-[0.7rem] px-1.5 py-0.5 rounded font-medium bg-green-500/10 text-[var(--color-success-text)]">
                    {text('已生成', 'Generated')}
                  </span>
                ) : (
                  <span
                    className="text-[0.7rem] px-1.5 py-0.5 rounded"
                    style={{ backgroundColor: 'rgba(var(--color-accent-rgb,99 102 241),0.1)', color: 'var(--color-accent)' }}
                  >
                    {text('待生成', 'Not generated')}
                  </span>
                )}
                {wordCount > 0 && (
                  <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    {wordCount.toLocaleString()} {text('字符', 'characters')}
                  </span>
                )}
              </div>
            </div>

            {/* 缺少权威输入时的提示：大纲由故事架构三块驱动 */}
            {missingInputs.length > 0 && (
              <div
                className="rounded-md p-3 text-xs leading-relaxed"
                style={{
                  backgroundColor: 'rgba(245, 158, 11, 0.08)',
                  border: '1px solid var(--color-border)',
                  color: 'var(--color-warning-text)',
                }}
              >
                {text(
                  `建议先在「故事架构」完成：${missingInputs.map(key => text(...ARCH_INPUT_LABELS[key])).join('、')}。缺少这些权威输入时生成的大纲容易偏离设定。`,
                  `Finish these in Story architecture first: ${missingInputs.map(key => text(...ARCH_INPUT_LABELS[key])).join(', ')}. An outline generated without them tends to drift from the setting.`,
                )}
              </div>
            )}

            {/* 生成范围 */}
            {totalChapters > 0 && (
              <div
                className="rounded-md p-3 space-y-2"
                style={{ backgroundColor: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
              >
                <div className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                  <AlertTriangle size={12} style={{ color: 'var(--color-warning)' }} />
                  {text('本次生成范围', 'Batch scope')}
                </div>
                <div className="flex items-center gap-1.5 text-xs flex-wrap">
                  <span style={{ color: 'var(--color-text-muted)' }}>{text('第', 'From ch.')}</span>
                  <input
                    type="number"
                    min={1}
                    max={totalChapters}
                    value={rangeFrom}
                    onChange={event => setRangeFrom(event.target.value)}
                    placeholder="1"
                    aria-label={text('本次生成范围的起始章', 'First chapter of this batch')}
                    className="w-16 rounded-md px-2 py-1.5 text-xs outline-none"
                    style={{ color: 'var(--color-text)', backgroundColor: 'var(--color-panel)', border: '1px solid var(--color-border)' }}
                  />
                  <span style={{ color: 'var(--color-text-muted)' }}>{text('章 到第', 'to ch.')}</span>
                  <input
                    type="number"
                    min={1}
                    max={totalChapters}
                    value={rangeTo}
                    onChange={event => setRangeTo(event.target.value)}
                    placeholder={String(totalChapters)}
                    aria-label={text('本次生成范围的结束章', 'Last chapter of this batch')}
                    className="w-16 rounded-md px-2 py-1.5 text-xs outline-none"
                    style={{ color: 'var(--color-text)', backgroundColor: 'var(--color-panel)', border: '1px solid var(--color-border)' }}
                  />
                  <span className="text-xs flex-1" style={{ color: 'var(--color-text-muted)' }}>
                    {text(
                      `章（留空 = 全书 1–${totalChapters}）`,
                      `chapter (empty = whole book 1-${totalChapters})`,
                    )}
                  </span>
                </div>
                <p className="text-[0.7rem] leading-relaxed m-0" style={{ color: 'var(--color-text-muted)' }}>
                  {text(
                    '长篇建议分批：一次请求过多章节容易触发输出长度上限。已确认的章节区间不会被重新生成覆盖。',
                    'For long books, generate in batches: requesting too many chapters at once can hit the output length limit. Confirmed chapter ranges are never overwritten.',
                  )}
                </p>
              </div>
            )}

            <div className="flex items-center gap-2 flex-wrap">
              {incomplete && (
                <Button
                  size="sm"
                  disabled={disabled}
                  className="gap-1.5 bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-sm hover:from-amber-600 hover:to-orange-600 border-none"
                  onClick={() => void handleResume()}
                  title={text(
                    '上次生成被输出长度中断，已完成部分已保存。点击后 AI 从断点继续生成当前批次。',
                    'The previous run stopped at the output length limit and the completed part was saved. Click to continue the current batch from the break point.',
                  )}
                >
                  <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
                  {busy ? text('续写中...', 'Resuming...') : text('断点续写大纲', 'Continue outline')}
                </Button>
              )}
              {pendingBatch && (
                <Button
                  size="sm"
                  disabled={disabled}
                  className="gap-1.5 bg-gradient-to-r from-indigo-500 to-blue-500 text-white shadow-sm hover:from-indigo-600 hover:to-blue-600 border-none"
                  onClick={() => void handleContinueBatch()}
                  title={text(
                    `从第 ${coveredTo + 1} 章起继续生成剩余章节（已确认的第 1–${coveredTo} 章保持不变）。`,
                    `Continue generating the remaining chapters from chapter ${coveredTo + 1} (confirmed chapters 1-${coveredTo} stay unchanged).`,
                  )}
                >
                  <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
                  {busy
                    ? text('生成中...', 'Generating...')
                    : text(`续批（第 ${coveredTo + 1} 章起）`, `Continue (ch. ${coveredTo + 1}+)`)}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => void openFullView()}
                title={text('打开完整文本视图，可手动编辑', 'Open the full text view for manual editing')}
              >
                <FileText size={12} />
                {text('打开完整视图', 'Open full view')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
