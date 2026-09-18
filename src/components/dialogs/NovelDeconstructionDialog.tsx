import { useState, useCallback, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Label } from '../ui/Label'
import { Input } from '../ui/Input'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useLocaleStore } from '../../stores/locale-store'
import { ipc } from '../../services/ipc-client'
import type {
  ImportInspectionSummary,
  ImportRunSnapshot,
  ImportRunPreparationResult,
} from '../../shared/import-run'
import {
  createNovelStudyWorkflow,
  estimateImportCost,
} from '../../services/workflows/import-workflow'
import { captureProjectSession, isProjectSessionCurrent } from '../project-session-gate'
import { randomUUID } from '../../utils/id'
import { AlertTriangle, BookOpen, Clock, FolderOpen, RotateCcw, Zap } from 'lucide-react'

interface NovelDeconstructionDialogProps {
  open: boolean
  onClose: () => void
}

export default function NovelDeconstructionDialog({ open, onClose }: NovelDeconstructionDialogProps) {
  const createProject = useProjectStore((s) => s.createProject)
  const currentProject = useProjectStore((s) => s.currentProject)
  const startWorkflow = useWorkflowStore((s) => s.startWorkflow)
  const activeWorkflows = useWorkflowStore((s) => s.activeRuns)
  const text = useLocaleStore((s) => s.text)
  const locale = useLocaleStore((s) => s.locale)

  const [name, setName] = useState('')
  const [savePath, setSavePath] = useState('')
  const [targetMode, setTargetMode] = useState<'new' | 'current'>('new')

  const [inspection, setInspection] = useState<ImportInspectionSummary | null>(null)
  const [splitting, setSplitting] = useState(false)
  const [splitDone, setSplitDone] = useState(false)
  const [splitError, setSplitError] = useState('')
  const [selectionPreparation, setSelectionPreparation] = useState<ImportRunPreparationResult | null>(null)
  const [selectionProjectId, setSelectionProjectId] = useState('')

  const [importing, setImporting] = useState(false)
  const [resumableState, setResumableState] = useState<{
    boundProjectId: string
    runs: ImportRunSnapshot[]
  } | null>(null)
  const [selectedResumableRunId, setSelectedResumableRunId] = useState('')

  const resumableRuns = resumableState && currentProject?.id === resumableState.boundProjectId
    ? resumableState.runs.filter((run) => run.purpose === 'reference')
    : []
  const resumableRun = resumableRuns.find((run) => run.id === selectedResumableRunId)
    ?? resumableRuns[0]
    ?? null
  const resumableRunIsActive = resumableRun
    ? activeWorkflows.some((workflow) => workflow.id === resumableRun.id)
    : false

  useEffect(() => {
    if (!open || !currentProject) return
    const session = captureProjectSession(currentProject)
    if (!session) return
    let active = true
    void ipc.invokeWithProjectSession(session, 'db:import-run-list-resumable', currentProject.path)
      .then((runs) => {
        if (active && isProjectSessionCurrent(session)) {
          setResumableState(runs.length > 0 ? { boundProjectId: session.projectId, runs } : null)
          setSelectedResumableRunId((selected) => (
            runs.some((run) => run.id === selected) ? selected : (runs[0]?.id ?? '')
          ))
        }
      })
      .catch(() => {
        if (active && isProjectSessionCurrent(session)) setResumableState(null)
      })
    return () => { active = false }
  }, [open, currentProject])

  const launchRun = useCallback(async (run: ImportRunSnapshot) => {
    const project = useProjectStore.getState().currentProject
    const projectSession = captureProjectSession(project)
    if (!project || !projectSession) throw new Error(text('目标项目缺少有效会话', 'Target project has no valid session.'))

    const workflow = createNovelStudyWorkflow({
      projectPath: project.path,
      projectSession,
      run,
      executionOwner: `renderer-study-${Date.now()}`,
    })
    startWorkflow(workflow)
    onClose()
  }, [onClose, startWorkflow, text])

  const handleSelectFolder = useCallback(async () => {
    const folder = await ipc.invoke('dialog:select-folder')
    if (folder) setSavePath(folder)
  }, [])

  const handleSelectFiles = useCallback(async (
    explicitRun?: Pick<ImportRunSnapshot, 'id' | 'locale'>,
  ) => {
    setSplitting(true)
    setSplitError('')
    let operationSession: ReturnType<typeof captureProjectSession> = null
    try {
      let project = useProjectStore.getState().currentProject
      let projectSession = captureProjectSession(project)
      if (targetMode === 'new' && !explicitRun) {
        if (!name.trim() || !savePath.trim()) throw new Error(text(
          '请先填写新项目名称和保存位置，再选择小说文件。',
          'Enter the new project name and save location before choosing novel files.',
        ))
        const success = await createProject({
          name: name.trim(),
          path: savePath.trim(),
          genre: '',
          targetAudience: '',
          writingLanguage: locale,
        })
        if (!success) return
        project = useProjectStore.getState().currentProject
        projectSession = captureProjectSession(project)
        setTargetMode('current')
      }
      if (!project || !projectSession) throw new Error(text(
        '目标项目缺少有效会话，已拒绝读取小说文件。',
        'The target project has no valid session, so the novel files were not read.',
      ))
      operationSession = projectSession
      const runId = explicitRun?.id ?? randomUUID()
      const runLocale = explicitRun?.locale ?? locale
      const result = await ipc.invoke('dialog:select-novel-files', {
        runId,
        purpose: 'reference',
        locale: runLocale,
        expectedProjectPath: project.path,
      }, projectSession)

      if (!isProjectSessionCurrent(projectSession)) return
      if (!result) return

      setSplitDone(false)
      setSplitError('')
      setInspection(null)
      setSelectionPreparation(null)
      setSelectionProjectId('')

      if (result.success && result.preparation) {
        const prepared = result.preparation
        setSelectionPreparation(prepared)
        setSelectionProjectId(project.id)
        const preparedRun = prepared.run
        const chapterCount = preparedRun?.totalChapters
          ?? prepared.newChapterNumbers.length
          + prepared.duplicateChapterNumbers.length
          + prepared.conflictChapterNumbers.length
        setInspection(prepared.inspection ?? {
          inspectionId: runId,
          purpose: 'reference',
          sourceCount: preparedRun?.sourceDisplay.length ?? 0,
          sourceDisplayNames: preparedRun?.sourceDisplay.map((source) => source.displayName) ?? [],
          chapterCount,
          totalWords: preparedRun?.manifestWordCount ?? 0,
          totalBytes: preparedRun?.totalContentSize ?? 0,
          preview: [],
        })
        setSplitDone(true)
      } else {
        setSplitError(result.error || text('拆章失败', 'Could not split chapters'))
      }
    } catch (e) {
      if (operationSession && !isProjectSessionCurrent(operationSession)) return
      setSplitError(String(e))
    } finally {
      setSplitting(false)
    }
  }, [createProject, locale, name, savePath, targetMode, text])

  const handleImport = useCallback(async () => {
    if (!selectionPreparation?.run) return
    setImporting(true)
    try {
      await launchRun(selectionPreparation.run)
    } catch (err) {
      setSplitError(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(false)
    }
  }, [launchRun, selectionPreparation])

  const handleResume = useCallback(async () => {
    if (!resumableRun) return
    setImporting(true)
    try {
      await launchRun(resumableRun)
    } catch (e) {
      setSplitError(e instanceof Error ? e.message : String(e))
    } finally {
      setImporting(false)
    }
  }, [launchRun, resumableRun])

  const costEstimate = splitDone && inspection
    ? estimateImportCost(inspection.totalWords, inspection.chapterCount)
    : null

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpen size={18} className="text-[var(--color-accent)]" />
            {text('小说拆解与仿写', 'Novel Analysis and Style Study')}
          </DialogTitle>
          <DialogDescription>
            {text(
              '选择参考小说文件，AI 将执行结构拆解、文风提取、蓝图反推，生成研习档案并供后续写作参考。',
              'Select reference novel files. AI will analyze structure and style, infer blueprints, and build a reusable study dossier.',
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
          <div>
            <Label>{text('研习目标', 'Study Target')}</Label>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={targetMode === 'new' ? 'default' : 'outline'}
                onClick={() => setTargetMode('new')}
              >
                {text('创建新项目', 'Create New Project')}
              </Button>
              <Button
                type="button"
                variant={targetMode === 'current' ? 'default' : 'outline'}
                disabled={!currentProject}
                onClick={() => setTargetMode('current')}
              >
                {text('研习到当前项目', 'Study in Current Project')}
              </Button>
            </div>
            {targetMode === 'current' && currentProject && (
              <div className="mt-2 text-xs text-[var(--color-text-secondary)]">
                {text(`当前项目：${currentProject.name}`, `Current project: ${currentProject.name}`)}
              </div>
            )}
          </div>

          {targetMode === 'current' && resumableRun && (
            <div
              className="rounded-lg p-3 space-y-2 text-xs"
              style={{ border: '1px solid var(--color-warning)', backgroundColor: 'var(--color-hover)' }}
            >
              <div className="flex items-center gap-1.5 font-medium">
                <RotateCcw size={13} />
                {text('存在未完成的拆解研习', 'Unfinished study run detected')}
              </div>
              <div className="flex items-center justify-between">
                <span>{resumableRun.sourceDisplay?.[0]?.displayName ?? resumableRun.id}</span>
                <span>阶段：{resumableRun.stage}</span>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleResume} disabled={importing || resumableRunIsActive}>
                  {text('继续研习', 'Continue Study')}
                </Button>
              </div>
            </div>
          )}

          <div>
            <Label>{text('选择参考小说文件', 'Reference Novel Files')}</Label>
            <div className="flex gap-2">
              <div
                className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg text-xs truncate"
                style={{
                  backgroundColor: 'var(--color-input)',
                  border: '1px solid var(--color-border)',
                  color: inspection ? 'var(--color-text)' : 'var(--color-text-muted)',
                }}
              >
                <BookOpen size={14} className="shrink-0" />
                {inspection
                  ? text(`${inspection.sourceCount} 个文件已选择`, `${inspection.sourceCount} files selected`)
                  : text('支持 .txt / .md / .epub 文件', 'Supports .txt / .md / .epub files')}
              </div>
              <Button variant="outline" onClick={() => void handleSelectFiles()} disabled={splitting}>
                <FolderOpen size={14} />
                {text('选择', 'Choose')}
              </Button>
            </div>
          </div>

          {splitting && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs" style={{ backgroundColor: 'var(--color-hover)' }}>
              <div className="animate-spin w-3 h-3 border-2 border-current border-t-transparent rounded-full" />
              {text('正在拆章并准备结构拆解...', 'Splitting chapters and preparing analysis...')}
            </div>
          )}

          {splitError && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs" style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-error-text)' }}>
              <AlertTriangle size={14} />
              {splitError}
            </div>
          )}

          {splitDone && inspection && (
            <div className="rounded-lg overflow-hidden border border-[var(--color-border)]">
              <div className="flex items-center gap-4 px-3 py-2 text-xs font-medium bg-[var(--color-hover)]">
                <span>{text(`共 ${inspection.chapterCount} 章`, `${inspection.chapterCount} chapters`)}</span>
                <span className="text-[var(--color-text-muted)]">{text(`${inspection.totalWords.toLocaleString()} 字`, `${inspection.totalWords.toLocaleString()} words`)}</span>
                <span className="text-[var(--color-text-muted)]">
                  {text(
                    `平均 ${Math.round(inspection.totalWords / inspection.chapterCount).toLocaleString()} 字/章`,
                    `Avg ${Math.round(inspection.totalWords / inspection.chapterCount).toLocaleString()} words/ch`,
                  )}
                </span>
              </div>
              <div className="px-3 py-2 space-y-1 max-h-36 overflow-y-auto">
                {inspection.preview.map((ch) => (
                  <div key={ch.number} className="flex items-center justify-between text-xs">
                    <span className="truncate flex-1 text-[var(--color-text-secondary)]">
                      {text(`第${ch.number}章 ${ch.title}`, `Ch ${ch.number} ${ch.title}`)}
                    </span>
                    <span className="text-[var(--color-text-muted)] text-[0.7rem]">
                      {text(`${ch.wordCount.toLocaleString()} 字`, `${ch.wordCount.toLocaleString()} words`)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {targetMode === 'new' && (
            <>
              <div>
                <Label>{text('新项目名称', 'New Project Name')}</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={text('拆解后创建的新项目名称', 'Name for the new project')}
                />
              </div>

              <div>
                <Label>{text('保存位置', 'Save Location')}</Label>
                <div className="flex gap-2">
                  <Input
                    value={savePath}
                    onChange={(e) => setSavePath(e.target.value)}
                    placeholder={text('选择项目保存目录', 'Choose a project folder')}
                    className="flex-1"
                  />
                  <Button variant="outline" onClick={handleSelectFolder}>
                    <FolderOpen size={14} />
                    {text('选择', 'Choose')}
                  </Button>
                </div>
              </div>
            </>
          )}

          {costEstimate && (
            <div className="rounded-lg p-3 space-y-1.5 text-xs bg-[var(--color-hover)] border border-[var(--color-border)]">
              <div className="flex items-center gap-1.5 font-medium text-[var(--color-accent)]">
                <Zap size={13} />
                <span>{text('预估 AI 消耗', 'Estimated AI Usage')}</span>
              </div>
              <div className="text-[var(--color-text-muted)] whitespace-pre-line">
                {costEstimate.breakdown}
              </div>
              <div className="flex items-center gap-1 text-[var(--color-text-secondary)] pt-1">
                <Clock size={11} />
                <span>{text(`预计耗时 ~${costEstimate.estimatedMinutes} 分钟`, `About ${costEstimate.estimatedMinutes} minutes`)}</span>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{text('取消', 'Cancel')}</Button>
          <Button
            onClick={handleImport}
            disabled={
              importing
              || !inspection
              || (targetMode === 'current' && (
                !selectionPreparation
                || currentProject?.id !== selectionProjectId
              ))
              || !currentProject
            }
          >
            {importing
              ? text('拆解中...', 'Analyzing...')
              : text(`开始拆解仿写（${inspection?.chapterCount ?? 0} 章）`, `Start Analysis (${inspection?.chapterCount ?? 0} chapters)`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
