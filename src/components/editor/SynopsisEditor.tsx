import { useState, useEffect, useCallback, useRef } from 'react'
import { Map, AlertTriangle, CheckCircle2, Circle, RefreshCw, FileText, Save, RotateCcw, ChevronDown, ChevronRight } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useEditorStore } from '../../stores/editor-store'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { toast } from '../ui/Toast'
import { ipc } from '../../services/ipc-client'
import { requireIpcSuccess } from '../../services/ipc-result'
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
  groupSynopsisNodes,
  parseSynopsis,
  pickCurrentNodeId,
  replaceSynopsisNodeBody,
  synopsisNodeBody,
  type ParsedSynopsis,
  type SynopsisNode,
} from './synopsis-outline-nodes'
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

const EMPTY_OUTLINE: ParsedSynopsis = { title: '', nodes: [], markerStart: null, hasChapterLabels: false }

type RangeResolution =
  | { ok: true; range?: { from: number; to: number } }
  | { ok: false }

/**
 * 情节大纲（与故事架构、小说配置、章节蓝图并列的一级页面）。
 *
 * 左侧按结构拐点列出章节区间，右侧编辑该区间的大纲正文；保存时只把该段
 * 替换回整份大纲并写入数据库。生成入口（按章区间 / 断点续写 / 续批）在顶部工具栏。
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
  const [saving, setSaving] = useState(false)
  const [rangeFrom, setRangeFrom] = useState('')
  const [rangeTo, setRangeTo] = useState('')
  const [outlineText, setOutlineText] = useState('')
  const [parsed, setParsed] = useState<ParsedSynopsis>(EMPTY_OUTLINE)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  const lastCompletedRunRef = useRef<string | null>(null)
  const requestGate = useRef(new LatestRequestGate())
  /** 右侧整份文档的滚动容器与各段落元素（左侧目录滚动定位用）。 */
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({})

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
      setOutlineText('')
      setParsed(EMPTY_OUTLINE)
      setSelectedNodeId(null)
      setDrafts({})
      setCollapsedGroups({})
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

    const nextParsed = parseSynopsis(dbSynopsis)
    setExists(generated)
    setWordCount(generated ? dbSynopsis.length : 0)
    setIncomplete(interrupted && generated)
    setRecoveryFailed(failedRecovery && generated)
    setCoveredTo(covered)
    setTotalChapters(total)
    setMissingInputs(generated ? [] : missing)
    setOutlineText(dbSynopsis)
    setParsed(nextParsed)
    // 外部重新生成后，只保留仍然存在的节点的未保存草稿。
    setDrafts(current => {
      const ids = new Set(nextParsed.nodes.map(node => node.id))
      const kept = Object.entries(current).filter(([id]) => ids.has(id))
      return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept)
    })
    setSelectedNodeId(current => (
      current && nextParsed.nodes.some(node => node.id === current)
        ? current
        : nextParsed.nodes[0]?.id ?? null
    ))
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

  /** 左侧目录点击：选中并把右侧文档滚动到该段。 */
  const scrollToNode = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId)
    const container = scrollRef.current
    const element = sectionRefs.current[nodeId]
    if (!container || !element) return
    const top = element.getBoundingClientRect().top
      - container.getBoundingClientRect().top
      + container.scrollTop
    container.scrollTo({ top: Math.max(0, top - 8) })
  }, [])

  /** 右侧滚动时反查当前所在段落，让目录高亮跟随。 */
  const handleDocumentScroll = useCallback(() => {
    const container = scrollRef.current
    const nodes = parsed.nodes
    if (!container || nodes.length === 0) return
    const containerTop = container.getBoundingClientRect().top
    const offsets: Array<{ id: string; top: number }> = []
    for (const node of nodes) {
      const element = sectionRefs.current[node.id]
      if (!element) continue
      offsets.push({ id: node.id, top: element.getBoundingClientRect().top - containerTop })
    }
    const current = pickCurrentNodeId(
      offsets,
      container.scrollTop,
      container.clientHeight,
      container.scrollHeight,
    )
    if (!current) return
    setSelectedNodeId(previous => (previous === current ? previous : current))
  }, [parsed.nodes])

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

  const pendingBatch = !incomplete && !recoveryFailed && coveredTo > 0 && coveredTo < totalChapters
  const disabled = loading || busy || isArchRunning
  const groups = groupSynopsisNodes(parsed.nodes)
  const selectedGroupId = groups.find(group => group.nodes.some(node => node.id === selectedNodeId))?.id ?? null
  // 默认只展开当前选中项所在的分组，其余按每 10 章折叠；手动展开/折叠优先。
  const isGroupOpen = (groupId: string) => collapsedGroups[groupId] ?? groupId === selectedGroupId
  const toggleGroup = (groupId: string) => {
    setCollapsedGroups(current => ({ ...current, [groupId]: !(current[groupId] ?? groupId === selectedGroupId) }))
  }
  const dirtyCount = Object.keys(drafts).length
  const markerText = parsed.markerStart === null ? '' : outlineText.slice(parsed.markerStart).trim()

  /** 编辑某个结构节点的正文；与原文一致时撤销该节点的草稿标记。 */
  const handleNodeBodyChange = (node: SynopsisNode, value: string) => {
    setDrafts(current => {
      if (value === synopsisNodeBody(node)) {
        if (current[node.id] === undefined) return current
        const next = { ...current }
        delete next[node.id]
        return next
      }
      return { ...current, [node.id]: value }
    })
  }

  const handleDiscardNodes = (nodeIds: readonly string[]) => {
    setDrafts(current => {
      let changed = false
      const next = { ...current }
      for (const nodeId of nodeIds) {
        if (next[nodeId] === undefined) continue
        delete next[nodeId]
        changed = true
      }
      return changed ? next : current
    })
  }

  /** 把草稿段的正文替换回整份大纲并保存；从后往前替换，前面的偏移不受影响。 */
  const saveNodes = async (nodeIds: readonly string[]) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    if (!isProjectSessionCurrent(projectSession)) return
    const targets = parsed.nodes
      .filter(node => nodeIds.includes(node.id) && drafts[node.id] !== undefined)
      .sort((a, b) => b.bodyStart - a.bodyStart)
    if (targets.length === 0) return
    setSaving(true)
    try {
      let nextText = outlineText
      for (const node of targets) {
        nextText = replaceSynopsisNodeBody(nextText, node, drafts[node.id])
      }
      requireIpcSuccess(
        await ipc.invokeWithProjectSession(
          projectSession,
          'db:project-core-update',
          { synopsis: nextText },
          projectSession.projectPath,
        ),
        text('保存情节大纲', 'Save the plot outline'),
      )
      if (!isProjectSessionCurrent(projectSession)) return
      setOutlineText(nextText)
      setParsed(parseSynopsis(nextText))
      setDrafts(current => {
        const next = { ...current }
        for (const node of targets) delete next[node.id]
        return next
      })
      const tabId = createProjectArchTabId(projectKey, SYNOPSIS_FILE_PATH)
      const store = useEditorStore.getState()
      if (store.tabs.some(tab => tab.id === tabId)) {
        store.syncTabContent(tabId, nextText)
        store.markTabSaved(tabId, nextText)
      }
      toast.success(pendingBatch
        ? text(
            '已保存；手动修改后需重新生成大纲才能继续续批。',
            'Saved. After a manual edit, regenerate the outline before continuing the remaining batches.',
          )
        : text('情节大纲已保存', 'Plot outline saved'))
      await loadStatus()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      toast.error(text(`保存失败：${detail}`, `Could not save: ${detail}`))
    } finally {
      if (isProjectSessionCurrent(projectSession)) setSaving(false)
    }
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 顶部工具栏：生成入口与视图切换 */}
      <div
        className="flex items-center justify-between gap-2 px-3 h-10 flex-shrink-0 border-b"
        style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-sidebar)' }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <Map size={14} style={{ color: 'var(--color-text-muted)' }} />
          <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
            {text('情节大纲', 'Plot outline')}
          </span>
          {parsed.nodes.length > 0 && (
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {text(`${parsed.nodes.length} 段`, `${parsed.nodes.length} sections`)}
            </span>
          )}
          {dirtyCount > 0 && (
            <span className="inline-flex items-center gap-1 text-[0.7rem]" style={{ color: 'var(--color-accent)' }}>
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: 'currentColor' }} />
              {text(`未保存 ${dirtyCount} 段`, `${dirtyCount} unsaved`)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {dirtyCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={saving}
              onClick={() => void saveNodes(Object.keys(drafts))}
              title={text('保存全部未保存的段落', 'Save every unsaved section')}
            >
              <Save size={12} />
              {saving ? text('保存中...', 'Saving...') : text('保存全部', 'Save all')}
            </Button>
          )}
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
            variant="ai"
            size="sm"
            onClick={() => void handleGenerate()}
            disabled={disabled}
            title={text('按下方范围生成情节大纲', 'Generate the plot outline for the range below')}
          >
            <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
            {exists ? text('AI 重新生成', 'Regenerate') : text('AI 生成大纲', 'Generate outline')}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void loadStatus()}
            title={text('刷新状态', 'Refresh status')}
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => void openFullView()}
            title={text('打开完整文本视图，可手动编辑整份大纲', 'Open the full text view to edit the whole outline')}
          >
            <FileText size={12} />
            {text('完整视图', 'Full view')}
          </Button>
        </div>
      </div>

      {/* 状态条：进度徽标、字数与本次生成范围 */}
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 flex-shrink-0 border-b text-xs"
        style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-panel)' }}
      >
        <span className="flex items-center gap-1.5">
          {exists
            ? recoveryFailed
              ? <AlertTriangle size={13} style={{ color: 'var(--color-warning)' }} />
              : <CheckCircle2 size={13} style={{ color: 'var(--color-success)' }} />
            : <Circle size={13} style={{ color: 'var(--color-text-muted)' }} />}
          {recoveryFailed ? (
            <span className="px-1.5 py-0.5 rounded font-medium bg-yellow-500/15 text-[var(--color-warning-text)]">
              {text('不完整 · 检查点不可恢复', 'Incomplete · checkpoint unavailable')}
            </span>
          ) : incomplete ? (
            <span className="px-1.5 py-0.5 rounded font-medium bg-yellow-500/15 text-[var(--color-warning-text)]">
              {text('不完整 · 已存部分', 'Incomplete · partial saved')}
            </span>
          ) : pendingBatch ? (
            <span className="px-1.5 py-0.5 rounded font-medium bg-yellow-500/15 text-[var(--color-warning-text)]">
              {text(`已覆盖至第 ${coveredTo} 章 · 待续批`, `Covered to ch. ${coveredTo} · pending`)}
            </span>
          ) : exists ? (
            <span className="px-1.5 py-0.5 rounded font-medium bg-green-500/10 text-[var(--color-success-text)]">
              {text('已生成', 'Generated')}
            </span>
          ) : (
            <span
              className="px-1.5 py-0.5 rounded"
              style={{ backgroundColor: 'rgba(var(--color-accent-rgb,99 102 241),0.1)', color: 'var(--color-accent)' }}
            >
              {text('待生成', 'Not generated')}
            </span>
          )}
          {wordCount > 0 && (
            <span style={{ color: 'var(--color-text-muted)' }}>
              {wordCount.toLocaleString()} {text('字符', 'characters')}
            </span>
          )}
        </span>

        {totalChapters > 0 && (
          <span className="flex items-center gap-1.5">
            <span style={{ color: 'var(--color-text-secondary)' }}>{text('本次生成范围', 'Batch scope')}</span>
            <span style={{ color: 'var(--color-text-muted)' }}>{text('第', 'From ch.')}</span>
            <input
              type="number"
              min={1}
              max={totalChapters}
              value={rangeFrom}
              onChange={event => setRangeFrom(event.target.value)}
              placeholder="1"
              aria-label={text('本次生成范围的起始章', 'First chapter of this batch')}
              className="w-16 rounded-md px-2 py-1 text-xs outline-none"
              style={{ color: 'var(--color-text)', backgroundColor: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
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
              className="w-16 rounded-md px-2 py-1 text-xs outline-none"
              style={{ color: 'var(--color-text)', backgroundColor: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
            />
            <span style={{ color: 'var(--color-text-muted)' }}>
              {text(`章（留空 = 全书 1–${totalChapters}）`, `chapter (empty = whole book 1-${totalChapters})`)}
            </span>
          </span>
        )}

        {missingInputs.length > 0 && (
          <span className="leading-relaxed" style={{ color: 'var(--color-warning-text)' }}>
            {text(
              `建议先在「故事架构」完成：${missingInputs.map(key => text(...ARCH_INPUT_LABELS[key])).join('、')}，否则大纲缺少权威输入。`,
              `Finish these in Story architecture first: ${missingInputs.map(key => text(...ARCH_INPUT_LABELS[key])).join(', ')}.`,
            )}
          </span>
        )}
        {totalChapters > SCOPE_WARNING_THRESHOLD && (
          <span style={{ color: 'var(--color-text-muted)' }}>
            {text(
              '长篇建议分批：一次请求过多章节容易触发输出长度上限，已确认区间不会被覆盖。',
              'For long books, generate in batches: too many chapters at once can hit the output length limit, and confirmed ranges are never overwritten.',
            )}
          </span>
        )}
      </div>

      {/* 主区域：左侧章节区间列表 + 右侧大纲正文 */}
      <div className="flex-1 flex overflow-hidden">
        <div
          className="flex flex-col flex-shrink-0 w-[220px] border-r overflow-hidden"
          style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-sidebar)' }}
        >
          {parsed.nodes.length === 0 ? (
            <div className="flex flex-col items-center justify-center flex-1 gap-3 opacity-40 p-4">
              <Map size={28} />
              <span className="text-xs text-center">
                {text(
                  '尚无大纲内容，点击右上角「AI 生成大纲」按章区间生成。',
                  'No outline yet. Use “Generate outline” above to create one by chapter range.',
                )}
              </span>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-1" data-testid="synopsis-toc">
              {groups.map(group => {
                const open = isGroupOpen(group.id)
                const groupDirty = group.nodes.some(node => drafts[node.id] !== undefined)
                const holdsSelection = group.id === selectedGroupId
                return (
                  <div key={group.id} className="mb-0.5">
                    {/* 分组标题：每 10 章一段，点击折叠/展开 */}
                    <div
                      className={`flex items-center gap-1 rounded-md px-2 py-1.5 text-xs cursor-pointer select-none transition-colors ${
                        holdsSelection && !open
                          ? 'bg-[var(--color-active)] text-[var(--color-text)]'
                          : 'hover:bg-[var(--color-hover)]'
                      }`}
                      style={{ color: holdsSelection && !open ? undefined : 'var(--color-text-secondary)' }}
                      onClick={() => toggleGroup(group.id)}
                      title={text(
                        `${group.label}（${group.nodes.length} 段）`,
                        `${group.label} (${group.nodes.length} sections)`,
                      )}
                    >
                      {open
                        ? <ChevronDown size={12} className="flex-shrink-0" style={{ color: 'var(--color-text-muted)' }} />
                        : <ChevronRight size={12} className="flex-shrink-0" style={{ color: 'var(--color-text-muted)' }} />}
                      <span className="font-medium truncate flex-1">{group.label}</span>
                      {groupDirty && (
                        <span
                          aria-hidden="true"
                          className="h-1.5 w-1.5 rounded-full flex-shrink-0"
                          style={{ backgroundColor: 'var(--color-accent)' }}
                        />
                      )}
                      <span className="text-[0.7rem] flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                        {group.nodes.length}
                      </span>
                    </div>

                    {open && (
                      <div>
                        {group.nodes.map(node => {
                          const nodeDirty = drafts[node.id] !== undefined
                          const active = node.id === selectedNodeId
                          return (
                            <div
                              key={node.id}
                              className={`relative ml-2 px-2.5 py-2 rounded-md text-xs cursor-pointer mb-0.5 transition-colors ${
                                active
                                  ? 'bg-[var(--color-active)] text-[var(--color-text)]'
                                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-hover)]'
                              }`}
                              onClick={() => scrollToNode(node.id)}
                              aria-current={active ? 'true' : undefined}
                              title={node.title || node.label}
                            >
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono text-[0.7rem] opacity-40 flex-shrink-0">
                                  {node.startChapter ?? '—'}
                                </span>
                                <span className="font-medium truncate flex-1">{node.label}</span>
                                {nodeDirty && (
                                  <span
                                    aria-hidden="true"
                                    className="h-1.5 w-1.5 rounded-full flex-shrink-0"
                                    style={{ backgroundColor: 'var(--color-accent)' }}
                                  />
                                )}
                              </div>
                              <div className="flex items-center gap-1 mt-0.5">
                                {node.title && <span className="truncate flex-1 opacity-80">{node.title}</span>}
                                {node.volume && (
                                  <span className="text-[0.7rem] px-1 py-0.5 rounded bg-[var(--color-hover)] flex-shrink-0">
                                    {node.volume}
                                  </span>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* 右侧：整份大纲拼接成一篇文档，左侧目录负责滚动定位 */}
        <div
          ref={scrollRef}
          onScroll={handleDocumentScroll}
          data-testid="synopsis-document"
          className="flex-1 overflow-y-auto relative"
        >
          {parsed.nodes.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <EmptyState
                icon={<Map size={36} />}
                message={text(
                  '尚未生成情节大纲，点击右上角「AI 生成大纲」开始。',
                  'No plot outline yet. Use “Generate outline” above to start.',
                )}
                opacity={0.4}
              />
            </div>
          ) : (
            <div className="max-w-3xl mx-auto px-6 py-5">
              <h1 className="text-base font-bold mb-4" style={{ color: 'var(--color-text)' }}>
                {parsed.title || text('情节大纲', 'Plot outline')}
              </h1>

              <div className="space-y-1">
                {parsed.nodes.map(node => {
                  const body = drafts[node.id] ?? synopsisNodeBody(node)
                  const dirty = drafts[node.id] !== undefined
                  const active = node.id === selectedNodeId
                  return (
                    <section
                      key={node.id}
                      ref={element => { sectionRefs.current[node.id] = element }}
                      data-node-id={node.id}
                      className="rounded-md px-3 py-2 transition-colors"
                      style={{ backgroundColor: active ? 'var(--color-hover)' : 'transparent' }}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <h2 className="text-sm font-bold truncate" style={{ color: 'var(--color-text)' }}>
                          {node.label}
                          {node.title ? `：${node.title}` : ''}
                        </h2>
                        {node.volume && (
                          <span
                            className="text-[0.7rem] px-1 py-0.5 rounded flex-shrink-0"
                            style={{ backgroundColor: 'var(--color-active)', color: 'var(--color-text-muted)' }}
                          >
                            {node.volume}
                          </span>
                        )}
                        {dirty && (
                          <span
                            aria-hidden="true"
                            className="h-1.5 w-1.5 rounded-full flex-shrink-0"
                            style={{ backgroundColor: 'var(--color-accent)' }}
                          />
                        )}
                        <span className="flex-1" />
                        {dirty && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="gap-1"
                              disabled={saving}
                              onClick={() => handleDiscardNodes([node.id])}
                              aria-label={text(`放弃「${node.label}」的修改`, `Discard changes to ${node.label}`)}
                              title={text(`放弃「${node.label}」的修改`, `Discard changes to ${node.label}`)}
                            >
                              <RotateCcw size={11} />
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="gap-1"
                              disabled={saving}
                              onClick={() => void saveNodes([node.id])}
                              aria-label={text(`保存「${node.label}」`, `Save ${node.label}`)}
                              title={text(`保存「${node.label}」`, `Save ${node.label}`)}
                            >
                              <Save size={11} />
                              {text('保存', 'Save')}
                            </Button>
                          </>
                        )}
                      </div>
                      <AutoGrowTextarea
                        value={body}
                        onChange={value => handleNodeBodyChange(node, value)}
                        ariaLabel={text(`${node.label}的大纲正文`, `Outline body of ${node.label}`)}
                        placeholder={text('写下这个章节区间的结构拐点…', 'Describe the turning points for this chapter range…')}
                      />
                    </section>
                  )
                })}
              </div>

              {markerText && (
                <p
                  className="mt-5 pt-3 text-[0.7rem] leading-relaxed border-t"
                  style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}
                >
                  {markerText}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** 右侧文档里的段落正文：随内容自动增高，看起来像连续正文而不是输入框。 */
function AutoGrowTextarea({
  value,
  onChange,
  ariaLabel,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  ariaLabel: string
  placeholder: string
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const resize = () => {
      element.style.height = 'auto'
      element.style.height = `${element.scrollHeight}px`
    }
    resize()
    // 面板宽度变化会改变折行，需要重新量一次高度。
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [value])

  return (
    <textarea
      ref={ref}
      value={value}
      rows={1}
      onChange={event => onChange(event.target.value)}
      aria-label={ariaLabel}
      placeholder={placeholder}
      className="w-full resize-none bg-transparent outline-none rounded-sm px-1 py-0.5 text-xs leading-relaxed font-mono"
      style={{ color: 'var(--color-text-secondary)', minHeight: 24 }}
      onFocus={event => { event.currentTarget.style.backgroundColor = 'var(--color-panel)' }}
      onBlur={event => { event.currentTarget.style.backgroundColor = 'transparent' }}
    />
  )
}
