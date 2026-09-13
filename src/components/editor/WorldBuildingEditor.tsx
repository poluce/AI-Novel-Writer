import { useState, useEffect, useCallback, useRef } from 'react'
import { Sparkles, CheckCircle2, Circle, RefreshCw, FileText, BookOpen, AlertTriangle, FolderTree } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useLocaleStore } from '../../stores/locale-store'
import { renderIcon } from '../panels/sidebar/sidebar-icons'

import ArchitectureConfirmDialog from '../dialogs/ArchitectureConfirmDialog'

import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { ipc } from '../../services/ipc-client'
import { toast } from '../ui/Toast'

import { launchCreativeWorkflow } from '../../services/workflows/creative-workflow-launcher'
import { globalEventBus } from '../../shared/event-bus'
import {
  createProjectArchTabId,
  shouldRefreshArchOnWorkflowComplete,
  shouldSyncProjectArchTab,
} from './arch-file-refresh-policy'
import { LatestRequestGate } from './latest-request-gate'
import {
  canExplicitlyRepairCharacterRoster,
  getCharacterRosterRepairPresentation,
} from './character-roster-repair-state'
import { useCharacterRosterRepair } from './use-character-roster-repair'
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
import { SettingDocument, SettingSection, DocumentBody } from './SettingSections'

type ArchStepKey = 'premise' | 'characters' | 'worldbuilding' | 'synopsis'

const ARCH_FILES: Array<{
  key: ArchStepKey
  fileName: string
  labelZh: string
  labelEn: string
  iconName: string
  descZh: string
  descEn: string
}> = [
    { key: 'premise', fileName: 'premise.md', labelZh: '故事前提', labelEn: 'Story premise', iconName: 'target', descZh: '故事钩子 · 核心冲突链 · 主角优势 · 悬念骨架', descEn: 'Story hook · core conflict · protagonist edge · suspense structure' },
    { key: 'characters', fileName: 'characters.md', labelZh: '角色图谱', labelEn: 'Character map', iconName: 'users', descZh: '角色弧光 · 关系网络 · 矛盾交织', descEn: 'Character arcs · relationships · interlocking tensions' },
    { key: 'worldbuilding', fileName: 'worldbuilding.md', labelZh: '世界观', labelEn: 'Worldbuilding', iconName: 'globe', descZh: '核心规则 · 社会结构 · 深层危机', descEn: 'Core rules · social structure · underlying crisis' },
    { key: 'synopsis', fileName: 'synopsis.md', labelZh: '情节大纲', labelEn: 'Plot outline', iconName: 'map', descZh: '结构推进 · 转折节奏 · 伏笔闭环', descEn: 'Story progression · turning points · setup and payoff' },
  ]

/** 续批按钮默认的每批章数上限（可在弹窗内调整，避免一次请求剩余全部章节）。 */
const CONTINUATION_BATCH_SPAN = 20

/** 可单块 AI 生成、按顺序解锁的前三个步骤。 */
const GENERATABLE_STEPS: Array<'premise' | 'characters' | 'worldbuilding'> = ['premise', 'characters', 'worldbuilding']

/** 故事架构编辑器 — 前三块与小说配置同款设置文档 + 单块 AI 生成；情节大纲独立面板 */
export default function WorldBuildingEditor({ projectKey }: { projectKey: string }) {
  // ✅ 精确订阅，避免 novelConfig 等变化导致不必要的 loadStatus 重建
  const currentProject = useProjectStore(s => s.currentProject)
  const text = useLocaleStore(s => s.text)
  const projectMatches = currentProject?.path === projectKey
  const [archStatus, setArchStatus] = useState<Record<string, boolean>>({})
  const [wordCounts, setWordCounts] = useState<Record<string, number>>({})
  const [archTexts, setArchTexts] = useState<Record<string, string>>({})
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({})
  const [generatingBlock, setGeneratingBlock] = useState<Exclude<ArchStepKey, 'synopsis'> | null>(null)
  const [synopsisIncomplete, setSynopsisIncomplete] = useState(false)
  const [synopsisRecoveryFailed, setSynopsisRecoveryFailed] = useState(false)
  const [synopsisCoveredTo, setSynopsisCoveredTo] = useState<number>(0)
  const [synopsisTotalChapters, setSynopsisTotalChapters] = useState<number>(0)
  const [synopsisBusy, setSynopsisBusy] = useState(false)
  const [pendingSynopsisRange, setPendingSynopsisRange] = useState<{ from: number; to: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [showArchDialog, setShowArchDialog] = useState(false)
  const lastCompletedArchitectureRunRef = useRef<string | null>(null)
  const archStatusRequestGate = useRef(new LatestRequestGate())
  const saveTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const {
    snapshot: rosterSnapshot,
    repairError: rosterRepairError,
    isRepairing: extracting,
    refresh: loadCharacterRosterStatus,
    migrate: handleRepairCharacterRoster,
  } = useCharacterRosterRepair({ projectKey, enabled: projectMatches })

  const isArchRunning = useWorkflowStore(s => s.isTypeRunning('architecture_generation'))

  /** 加载各架构文件状态（通过 Service 层获取，不直接调 IPC） */
  const loadStatus = useCallback(async () => {
    await Promise.resolve()
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) {
      archStatusRequestGate.current.begin()
      setArchStatus({})
      setWordCounts({})
      setArchTexts({})
      setSynopsisIncomplete(false)
      setSynopsisRecoveryFailed(false)
      setSynopsisCoveredTo(0)
      setSynopsisTotalChapters(0)
      setLoading(false)
      return
    }
    const projectPath = projectSession.projectPath
    const requestId = archStatusRequestGate.current.begin()
    setLoading(true)
    const core = await ipc.invokeWithProjectSession(
      projectSession,
      'db:project-core-get',
      projectPath,
    )
    // 情节大纲状态：中断可断点续写；或部分覆盖可分批续写（covered_to < total）
    let interrupted = false
    let recoveryFailed = false
    let coveredTo = 0
    const dbSynopsis = core?.synopsis || ''
    const totalChapters = Number(core?.totalChapters ?? currentProject?.novelConfig?.totalChapters) || 0
    const writingLanguage = (core?.writingLanguage ?? currentProject?.novelConfig?.writingLanguage) === 'en-US'
      ? 'en-US'
      : 'zh-CN'
    const visiblyPartial = hasVisiblePartialSynopsisMarker(dbSynopsis)
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
      const checkpointUsable = isUsableSynopsisCheckpoint(
        partial,
        dbSynopsis,
        writingLanguage,
        totalChapters,
      )
      interrupted = checkpointUsable && isRecoverableSynopsisCheckpoint(
        partial,
        dbSynopsis,
        writingLanguage,
        totalChapters,
      )
      recoveryFailed = visiblyPartial && !checkpointUsable
      coveredTo = checkpointUsable && Number(partial?.synopsis_covered_to) > 0
        ? Number(partial?.synopsis_covered_to)
        : 0
    } catch {
      interrupted = false
      recoveryFailed = visiblyPartial
      coveredTo = 0
    }
    const rosterReady = rosterSnapshot?.status === 'ready'
    const status: Record<string, boolean> = {
      premise: (core?.premise?.length ?? 0) > 50,
      characters: rosterReady,
      worldbuilding: (core?.worldbuilding?.length ?? 0) > 50,
      synopsis: (core?.synopsis?.length ?? 0) > 50,
    }
    const counts: Record<string, number> = {
      premise: status.premise ? (core?.premise?.length ?? 0) : 0,
      characters: status.characters ? (rosterSnapshot?.renderedMarkdown.length ?? 0) : 0,
      worldbuilding: status.worldbuilding ? (core?.worldbuilding?.length ?? 0) : 0,
      synopsis: status.synopsis ? (core?.synopsis?.length ?? 0) : 0,
    }
    if (
      !archStatusRequestGate.current.isLatest(requestId)
      || !isProjectSessionCurrent(projectSession)
    ) return
    setArchStatus(status)
    setWordCounts(counts)
    setArchTexts({
      premise: core?.premise ?? '',
      worldbuilding: core?.worldbuilding ?? '',
      synopsis: dbSynopsis,
      characters: rosterSnapshot?.renderedMarkdown ?? '',
    })
    setSynopsisIncomplete(interrupted && Boolean(status.synopsis))
    setSynopsisRecoveryFailed(recoveryFailed && Boolean(status.synopsis))
    setSynopsisCoveredTo(coveredTo)
    setSynopsisTotalChapters(totalChapters)
    setLoading(false)
    // ✅ 只依赖 path 字符串，避免 novelConfig 等变化导致 loadStatus 重建
  }, [currentProject, projectKey, projectMatches, rosterSnapshot])

  useEffect(() => {
    const timer = setTimeout(() => { void loadStatus() }, 0)
    return () => clearTimeout(timer)
  }, [loadStatus])

  // 监听 EventBus 事件，刷新后处理状态面板
  useEffect(() => {
    const eventMatchesProjectRun = (payload: {
      projectSession: ProjectSessionContext
      runId: string
    }) =>
      (() => {
        const projectSession = captureProjectSession(currentProject)
        return !!projectSession
          && isProjectSessionCurrent(projectSession)
          && sameProjectSessionContext(projectSession, payload.projectSession)
      })()
      && payload.runId.length > 0
    // 每步架构文件写完后实时刷新状态
    const unsub3 = globalEventBus.on('ARCH_FILE_UPDATED', (payload) => {
      if (!eventMatchesProjectRun(payload)) return
      loadStatus()
      loadCharacterRosterStatus()
    })
    // 整个工作流完成后也刷新一次
    const unsub4 = globalEventBus.on('WORKFLOW_COMPLETE', (payload) => {
      const projectSession = captureProjectSession(currentProject)
      if (!projectSession || !isProjectSessionCurrent(projectSession)) return
      if (!shouldRefreshArchOnWorkflowComplete(
        payload,
        projectSession,
        lastCompletedArchitectureRunRef.current,
      )) return
      lastCompletedArchitectureRunRef.current = payload.runId
      setGeneratingBlock(null)
      loadStatus()
      loadCharacterRosterStatus()
    })
    return () => { unsub3(); unsub4() }
  }, [currentProject, loadCharacterRosterStatus, loadStatus, projectKey])

  /** 打开单个架构文件（arch-file 类型；若 tab 已存在则刷新磁盘内容） */
  const openArchFile = async (f: typeof ARCH_FILES[number]) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    const filePath = `vela://core/${f.key}`
    const tabId = createProjectArchTabId(projectKey, filePath)
    let content = ''
    try {
      if (f.key === 'characters') {
        const roster = await loadCharacterRosterStatus()
        if (!roster) return
        content = roster.status === 'ready'
          ? roster.renderedMarkdown
          : roster.legacyMarkdown ?? ''
      } else {
        const core = (await ipc.invokeWithProjectSession(
          projectSession,
          'db:project-core-get',
          projectSession.projectPath,
        )) as Record<string, unknown> | null
        content = (core?.[f.key] as string) || ''
      }
    } catch {
      return
    }
    if (!isProjectSessionCurrent(projectSession)) return

    const { useEditorStore } = await import('../../stores/editor-store')
    if (!isProjectSessionCurrent(projectSession)) return
    const store = useEditorStore.getState()
    const existingTab = store.tabs.find(t => t.id === tabId)
    if (existingTab) {
      store.setActiveTab(tabId)
      if (shouldSyncProjectArchTab(existingTab, projectKey)) {
        store.syncTabContent(tabId, content)
        store.markTabSaved(tabId, content)
      }
    } else {
      store.openFile({
        id: tabId,
        name: text(f.labelZh, f.labelEn),
        type: 'arch-file',
        filePath,
        content,
        savedContent: content,
        projectKey,
      })
    }
  }

  /** 确认后启动架构工作流 */
  const handleConfirm = async (
    selectedSteps: ArchStepKey[],
    stepGuidance: Record<string, string>,
    synopsisRange?: { from: number; to: number },
  ) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) throw new Error(text('项目会话已切换，未启动架构生成', 'The project session changed, so architecture generation was not started.'))
    if (!isProjectSessionCurrent(projectSession)) throw new Error(text('项目会话已切换，未启动架构生成', 'The project session changed, so architecture generation was not started.'))
    await launchCreativeWorkflow({
      workflow: 'generate_architecture',
      selectedSteps,
      stepGuidance,
      synopsisRange,
    }, projectSession)
  }

  /** 单块 AI 生成（故事前提 / 角色图谱 / 世界观，按顺序解锁） */
  const handleGenerateBlock = async (key: Exclude<ArchStepKey, 'synopsis'>) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    if (!isProjectSessionCurrent(projectSession)) return
    if (generatingBlock || isArchRunning) return
    setGeneratingBlock(key)
    try {
      await launchCreativeWorkflow({
        workflow: 'generate_architecture',
        selectedSteps: [key],
      }, projectSession)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      toast.error(text(`生成启动失败：${detail}`, `Failed to start generation: ${detail}`))
      if (isProjectSessionCurrent(projectSession)) setGeneratingBlock(null)
    }
  }

  /** 内联编辑保存（防抖写回 project_core） */
  const handleArchTextChange = (key: 'premise' | 'worldbuilding', value: string) => {
    setArchTexts(current => ({ ...current, [key]: value }))
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    const existing = saveTimerRef.current.get(key)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      saveTimerRef.current.delete(key)
      if (!captureProjectSession(useProjectStore.getState().currentProject)) return
      void ipc.invokeWithProjectSession(
        projectSession,
        'db:project-core-update',
        { [key]: value },
        projectSession.projectPath,
      ).then(() => {
        if (isProjectSessionCurrent(projectSession)) loadStatus()
      }).catch(() => {})
    }, 600)
    saveTimerRef.current.set(key, timer)
  }

  /** 从上次输出长度中断的检查点继续生成情节大纲（断点续写当前批） */
  const handleResumeSynopsis = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    if (!isProjectSessionCurrent(projectSession) || synopsisBusy) return
    setSynopsisBusy(true)
    try {
      await launchCreativeWorkflow({
        workflow: 'generate_architecture',
        selectedSteps: ['synopsis'],
        resumeSynopsis: true,
      }, projectSession)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      toast.error(text(`续写启动失败：${detail}`, `Failed to start the continuation: ${detail}`))
    } finally {
      setSynopsisBusy(false)
    }
  }

  /** 续批入口：打开生成弹窗并预填下一批范围（从 coveredTo+1 起，默认带本批上限，
   * 上限可在弹窗内调整）。避免一次请求剩余全部章节再次触发超长输出。 */
  const handleContinueOutlineBatch = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    if (!isProjectSessionCurrent(projectSession)) return
    const from = synopsisCoveredTo + 1
    if (from > synopsisTotalChapters || synopsisTotalChapters <= 0) return
    setPendingSynopsisRange({
      from,
      to: Math.min(synopsisTotalChapters, from + CONTINUATION_BATCH_SPAN - 1),
    })
    setShowArchDialog(true)
  }

  /** 打开普通「AI 生成架构」入口（不携带续批预填）。 */
  const openGenerateDialog = () => {
    setPendingSynopsisRange(null)
    setShowArchDialog(true)
  }

  if (!projectMatches) {
    return (
      <div className="h-full flex flex-col overflow-hidden bg-[var(--color-bg)]">
        <div
          className="flex items-center justify-between gap-2 px-3 h-9 flex-shrink-0"
          style={{
            borderBottom: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-editor-bg)',
          }}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs font-medium truncate text-[var(--color-text-secondary)]">
              {text('故事架构', 'Story architecture')}
            </span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto relative">
          <EmptyState icon={<BookOpen size={36} />} message={text('请先打开项目', 'Open a project to continue')} opacity={0.4} />
        </div>
      </div>
    )
  }

  const generatedCount = ARCH_FILES.filter(f => (
    archStatus[f.key] && !(f.key === 'synopsis' && synopsisRecoveryFailed)
  )).length
  const rosterPresentation = getCharacterRosterRepairPresentation(
    rosterSnapshot,
    text,
    rosterRepairError,
  )
  const canRepairRoster = canExplicitlyRepairCharacterRoster(rosterPresentation)

  /** 首次严格顺序；已生成的块可任意重新生成。 */
  const canGenerate = (key: 'premise' | 'characters' | 'worldbuilding'): boolean => {
    if (generatingBlock || isArchRunning || loading) return false
    if (archStatus[key]) return true
    if (key === 'premise') return true
    if (key === 'characters') return Boolean(archStatus.premise)
    return Boolean(archStatus.characters)
  }

  const sectionProps = (key: 'premise' | 'characters' | 'worldbuilding') => ({
    collapseKey: key,
    title: text(
      ARCH_FILES.find(f => f.key === key)!.labelZh,
      ARCH_FILES.find(f => f.key === key)!.labelEn,
    ),
    desc: text(
      ARCH_FILES.find(f => f.key === key)!.descZh,
      ARCH_FILES.find(f => f.key === key)!.descEn,
    ),
    generated: archStatus[key] ?? false,
    generating: generatingBlock === key,
    disabled: !canGenerate(key),
    wordCount: wordCounts[key] ?? 0,
  })

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 顶部工具栏 */}
      <div
        className="flex items-center justify-between gap-2 px-3 h-10 flex-shrink-0 border-b"
        style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-sidebar)' }}
      >
        <div className="flex items-center gap-1.5">
          <FolderTree size={14} style={{ color: 'var(--color-text-muted)' }} />
          <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
            {text('故事架构', 'Story architecture')}
          </span>
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {generatedCount}/{ARCH_FILES.length} {text('已生成', 'generated')}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon"
            onClick={loadStatus}
            title={text('刷新状态', 'Refresh status')}
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </Button>
          {/* AI 生成架构 — 与小说配置/章节蓝图保持一致的按钮位置 */}
          <Button
            variant="ai"
            size="sm"
            onClick={openGenerateDialog}
            disabled={isArchRunning}
            title={text('AI 生成故事架构（选择要生成的步骤）', 'Generate story architecture (choose steps to generate)')}
          >
            <Sparkles size={12} />
            {text('AI 生成架构', 'Generate story architecture')}
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 py-4">
          {/* 前三块：与小说配置同款设置文档 + 单块 AI 生成 */}
          <SettingDocument>
            {GENERATABLE_STEPS.map(key => {
              const s = sectionProps(key)
              const rosterNeedsAttention = key === 'characters' && rosterPresentation
                && rosterPresentation.kind !== 'ready'
                && rosterPresentation.kind !== 'empty'
              return (
                <SettingSection
                  key={key}
                  title={s.title}
                  collapsed={Boolean(collapsedSections[s.collapseKey])}
                  onToggle={() => setCollapsedSections(current => ({ ...current, [s.collapseKey]: !current[s.collapseKey] }))}
                  generating={s.generating}
                  generateDisabled={s.disabled}
                  generateTitle={!s.disabled ? undefined : text(
                    key === 'characters'
                      ? '请先完成「故事前提」生成'
                      : key === 'worldbuilding'
                        ? '请先完成「角色图谱」生成'
                        : '正在生成中…',
                    key === 'characters'
                      ? 'Generate the story premise first'
                      : key === 'worldbuilding'
                        ? 'Generate the character map first'
                        : 'Generating…',
                  )}
                  onGenerate={s.generating || s.disabled ? undefined : () => void handleGenerateBlock(key)}
                >
                  <div className="flex items-center justify-between gap-3 pt-1 pb-1">
                    <div className="flex items-center gap-2 min-w-0">
                      {s.generated
                        ? <CheckCircle2 size={15} style={{ flexShrink: 0, color: 'var(--color-success)' }} />
                        : <Circle size={15} style={{ flexShrink: 0, color: 'var(--color-text-muted)' }} />}
                      <span className="text-xs truncate" style={{ color: 'var(--color-text-muted)' }}>{s.desc}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {key === 'characters' && rosterPresentation && (
                        <span
                          role="status"
                          className="text-[0.7rem] px-1.5 py-0.5 rounded font-medium"
                          style={{
                            backgroundColor: rosterNeedsAttention
                              ? 'rgba(245, 158, 11, 0.12)'
                              : 'rgba(34, 197, 94, 0.1)',
                            color: rosterNeedsAttention
                              ? 'var(--color-warning-text)'
                              : 'var(--color-success-text)',
                          }}
                        >
                          {rosterPresentation.label}
                        </span>
                      )}
                      {s.wordCount > 0 && (
                        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                          {s.wordCount.toLocaleString()} {text('字符', 'characters')}
                        </span>
                      )}
                      <button
                        type="button"
                        className="p-0.5 rounded"
                        title={text('打开完整视图', 'Open full view')}
                        onClick={() => openArchFile(ARCH_FILES.find(f => f.key === key)!)}
                      >
                        <FileText size={13} style={{ color: 'var(--color-text-muted)' }} />
                      </button>
                    </div>
                  </div>
                  <DocumentBody
                    value={archTexts[key] ?? ''}
                    readOnly={key === 'characters' || !projectMatches}
                    placeholder={s.generated
                      ? text('（内容已生成，可直接编辑）', '(Generated — edit directly)')
                      : text(
                        key === 'characters'
                          ? '点击右上角「AI 生成」或先完成故事前提'
                          : '点击右上角「AI 生成」生成内容',
                        key === 'characters'
                          ? 'Click “AI 生成” above, or generate the premise first'
                          : 'Click “AI 生成” above to generate content',
                      )}
                    onChange={key === 'characters'
                      ? () => {}
                      : (value) => handleArchTextChange(key, value)}
                  />
                  {key === 'characters' && !loading && canRepairRoster && rosterPresentation?.actionLabel && (
                    <div className="pt-1.5">
                      <Button
                        size="sm"
                        disabled={extracting}
                        className="gap-1.5 bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-sm hover:from-amber-600 hover:to-orange-600 border-none hover:shadow hover:-translate-y-[0.5px] transition-all"
                        onClick={() => void handleRepairCharacterRoster()}
                        title={rosterPresentation.actionTitle}
                      >
                        {extracting
                          ? <RefreshCw size={12} className="animate-spin opacity-90" />
                          : <AlertTriangle size={12} className="opacity-90" />}
                        {extracting ? text('处理中...', 'Working...') : rosterPresentation.actionLabel}
                      </Button>
                    </div>
                  )}
                </SettingSection>
              )
            })}
          </SettingDocument>

          {/* 情节大纲：独立面板（断点续写 / 续批入口保持） */}
          <div className="mt-4">
            {(() => {
              const f = ARCH_FILES.find(item => item.key === 'synopsis')!
              const generated = archStatus[f.key]
              const synopsisNeedsRecovery = !!synopsisRecoveryFailed
              const words = wordCounts[f.key] ?? 0
              const cardBorderColor = synopsisNeedsRecovery
                ? 'var(--color-warning)'
                : generated
                  ? 'var(--color-success)'
                  : 'var(--color-border)'
              return (
                <div className="space-y-2">
                  <div
                    className="rounded-lg border p-4 flex items-center gap-4 cursor-pointer transition-all"
                    style={{
                      borderColor: cardBorderColor,
                      backgroundColor: 'var(--color-panel)',
                      opacity: loading ? 0.6 : 1,
                    }}
                    onClick={() => openArchFile(f)}
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-accent)'}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.borderColor = cardBorderColor}
                    title={`${text('点击查看', 'Open')} — ${text(f.descZh, f.descEn)}`}
                  >
                    {generated
                      ? synopsisNeedsRecovery
                        ? <AlertTriangle size={18} style={{ flexShrink: 0, color: 'var(--color-warning)' }} />
                        : <CheckCircle2 size={18} style={{ flexShrink: 0, color: 'var(--color-success)' }} />
                      : <Circle size={18} style={{ flexShrink: 0, color: 'var(--color-text-muted)' }} />}
                    <span className="flex-shrink-0" style={{ color: generated ? 'var(--color-text-secondary)' : 'var(--color-text-muted)' }}>{renderIcon(f.iconName, 24)}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                        {text(f.labelZh, f.labelEn)}
                      </div>
                      <div className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                        {text(f.descZh, f.descEn)}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 flex-shrink-0">
                      {generated ? (
                        <>
                          {synopsisNeedsRecovery ? (
                            <span className="text-[0.7rem] px-1.5 py-0.5 rounded font-medium bg-yellow-500/15 text-[var(--color-warning-text)]">
                              {text('不完整 · 检查点不可恢复', 'Incomplete · checkpoint unavailable')}
                            </span>
                          ) : synopsisIncomplete ? (
                            <span className="text-[0.7rem] px-1.5 py-0.5 rounded font-medium bg-yellow-500/15 text-[var(--color-warning-text)]">
                              {text('不完整 · 已存部分', 'Incomplete · partial saved')}
                            </span>
                          ) : synopsisCoveredTo > 0 && synopsisCoveredTo < synopsisTotalChapters ? (
                            <span className="text-[0.7rem] px-1.5 py-0.5 rounded font-medium bg-yellow-500/15 text-[var(--color-warning-text)]">
                              {text(`已覆盖至第 ${synopsisCoveredTo} 章 · 待续批`, `Covered to ch. ${synopsisCoveredTo} · pending`)}
                            </span>
                          ) : (
                            <span className="text-[0.7rem] px-1.5 py-0.5 rounded font-medium bg-green-500/10 text-[var(--color-success-text)]">
                              {text('已生成', 'Generated')}
                            </span>
                          )}
                          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                            {words.toLocaleString()} {text('字符', 'characters')}
                          </span>
                          {synopsisIncomplete && !loading && (
                            <Button
                              size="sm"
                              disabled={synopsisBusy}
                              className="gap-1.5 mt-0.5 bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-sm hover:from-amber-600 hover:to-orange-600 border-none hover:shadow hover:-translate-y-[0.5px] transition-all"
                              onClick={(e) => {
                                e.stopPropagation()
                                void handleResumeSynopsis()
                              }}
                              title={text(
                                '上次生成被输出长度中断，已完成部分已保存。点击后 AI 从断点继续生成当前批次。',
                                'The previous run stopped at the output length limit and the completed part was saved. Click to continue the current batch from the break point.',
                              )}
                            >
                              {synopsisBusy
                                ? <RefreshCw size={12} className="animate-spin opacity-90" />
                                : <RefreshCw size={12} className="opacity-90" />}
                              {synopsisBusy
                                ? text('续写中...', 'Resuming...')
                                : text('断点续写大纲', 'Continue outline')}
                            </Button>
                          )}
                          {!synopsisIncomplete && !synopsisRecoveryFailed
                            && synopsisCoveredTo > 0 && synopsisCoveredTo < synopsisTotalChapters && !loading && (
                            <Button
                              size="sm"
                              disabled={synopsisBusy}
                              className="gap-1.5 mt-0.5 bg-gradient-to-r from-indigo-500 to-blue-500 text-white shadow-sm hover:from-indigo-600 hover:to-blue-600 border-none hover:shadow hover:-translate-y-[0.5px] transition-all"
                              onClick={(e) => {
                                e.stopPropagation()
                                void handleContinueOutlineBatch()
                              }}
                              title={text(
                                `从第 ${synopsisCoveredTo + 1} 章起继续生成剩余章节（已确认的第 1–${synopsisCoveredTo} 章保持不变）。`,
                                `Continue generating the remaining chapters from chapter ${synopsisCoveredTo + 1} (confirmed chapters 1-${synopsisCoveredTo} stay unchanged).`,
                              )}
                            >
                              {synopsisBusy
                                ? <RefreshCw size={12} className="animate-spin opacity-90" />
                                : <RefreshCw size={12} className="opacity-90" />}
                              {synopsisBusy
                                ? text('生成中...', 'Generating...')
                                : text(`续批（第 ${synopsisCoveredTo + 1} 章起）`, `Continue (ch. ${synopsisCoveredTo + 1}+)`)}
                            </Button>
                          )}
                        </>
                      ) : (
                        <span
                          className="text-[0.7rem] px-1.5 py-0.5 rounded"
                          style={{ backgroundColor: 'rgba(var(--color-accent-rgb,99 102 241),0.1)', color: 'var(--color-accent)' }}
                        >
                          {text('待生成', 'Not generated')}
                        </span>
                      )}
                      <span className="text-[0.7rem] flex items-center gap-0.5" style={{ color: 'var(--color-text-muted)' }}>
                        <FileText size={10} /> {text('点击查看', 'Open')}
                      </span>
                    </div>
                  </div>
                </div>
              )
            })()}
          </div>
        </div>
      </div>

      {/* AI 生成架构确认弹窗 */}
      <ArchitectureConfirmDialog
        isOpen={showArchDialog}
        onClose={() => setShowArchDialog(false)}
        archStatus={archStatus}
        initialSynopsisRange={pendingSynopsisRange}
        onConfirm={handleConfirm}
      />
    </div>
  )
}
