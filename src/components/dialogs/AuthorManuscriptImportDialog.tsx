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
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useLocaleStore } from '../../stores/locale-store'
import { ipc } from '../../services/ipc-client'
import {
  AUTHOR_IMPORT_PREVIEW_STALE,
  type ImportInspectionSummary,
  type ImportRunSnapshot,
  type ImportRunPrepareFromInspectionRequest,
} from '../../shared/import-run'
import type { AuthorManuscriptImportPreview } from '../../shared/author-manuscript-import'
import { createAuthorManuscriptImportWorkflow, loadAuthorImportChapterNumbers } from '../../services/workflows/import-workflow'
import { captureProjectSession, isProjectSessionCurrent } from '../project-session-gate'
import { randomUUID } from '../../utils/id'
import { AlertTriangle, FileText, FolderOpen, RotateCcw } from 'lucide-react'

interface AuthorManuscriptImportDialogProps {
  open: boolean
  onClose: () => void
}

export default function AuthorManuscriptImportDialog({ open, onClose }: AuthorManuscriptImportDialogProps) {
  const currentProject = useProjectStore((s) => s.currentProject)
  const startWorkflow = useWorkflowStore((s) => s.startWorkflow)
  const activeWorkflows = useWorkflowStore((s) => s.activeRuns)
  const text = useLocaleStore((s) => s.text)
  const locale = useLocaleStore((s) => s.locale)

  const [inspection, setInspection] = useState<ImportInspectionSummary | null>(null)
  const [splitting, setSplitting] = useState(false)
  const [splitDone, setSplitDone] = useState(false)
  const [splitError, setSplitError] = useState('')
  const [authorPreview, setAuthorPreview] = useState<AuthorManuscriptImportPreview | null>(null)
  const [authorPreviewLoading, setAuthorPreviewLoading] = useState(false)

  const [importing, setImporting] = useState(false)
  const [importNotice, setImportNotice] = useState('')
  const [resumableState, setResumableState] = useState<{
    boundProjectId: string
    runs: ImportRunSnapshot[]
  } | null>(null)
  const [selectedResumableRunId, setSelectedResumableRunId] = useState('')

  const resumableRuns = resumableState && currentProject?.id === resumableState.boundProjectId
    ? resumableState.runs.filter((run) => run.purpose === 'author-manuscript')
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
    if (!project || !projectSession) {
      throw new Error(text('当前项目会话已失效', 'The project session expired.'))
    }

    const authorChapterNumbers = await loadAuthorImportChapterNumbers(run, projectSession, project.path)
    const workflow = createAuthorManuscriptImportWorkflow({
      projectPath: project.path,
      projectSession,
      run,
      executionOwner: `renderer-author-${Date.now()}`,
      authorChapterNumbers,
    })
    startWorkflow(workflow)
    onClose()
  }, [onClose, startWorkflow, text])

  const handleSelectFiles = useCallback(async (
    explicitRun?: Pick<ImportRunSnapshot, 'id' | 'locale'>,
  ) => {
    setSplitting(true)
    setSplitError('')
    let operationSession: ReturnType<typeof captureProjectSession> = null
    try {
      const project = useProjectStore.getState().currentProject
      const projectSession = captureProjectSession(project)
      if (!project || !projectSession) {
        throw new Error(text('目标项目缺少有效会话', 'Target project has no valid session.'))
      }
      operationSession = projectSession
      const runId = explicitRun?.id ?? randomUUID()
      const runLocale = explicitRun?.locale ?? locale

      const result = await ipc.invoke('dialog:select-novel-files', {
        runId,
        purpose: 'author-manuscript',
        locale: runLocale,
        expectedProjectPath: project.path,
      }, projectSession)

      if (!isProjectSessionCurrent(projectSession)) return
      if (!result) return

      setSplitDone(false)
      setSplitError('')
      setImportNotice('')
      setInspection(null)
      setAuthorPreview(null)
      setAuthorPreviewLoading(false)

      if (result.success && result.inspection) {
        setAuthorPreviewLoading(true)
        setInspection(result.inspection)
        setSplitDone(true)

        try {
          const preview = await ipc.invokeWithProjectSession(
            projectSession,
            'db:import-run-author-preview',
            result.inspection.inspectionId,
            project.path,
          )
          if (isProjectSessionCurrent(projectSession)) {
            setAuthorPreview(preview)
          }
        } catch (previewErr) {
          if (isProjectSessionCurrent(projectSession)) {
            setSplitError(String(previewErr))
          }
        } finally {
          if (isProjectSessionCurrent(projectSession)) {
            setAuthorPreviewLoading(false)
          }
        }
      } else {
        setSplitError(result.error || text('解析原稿失败', 'Could not parse manuscript.'))
      }
    } catch (e) {
      if (operationSession && !isProjectSessionCurrent(operationSession)) return
      setSplitError(String(e))
    } finally {
      setSplitting(false)
    }
  }, [locale, text])

  const handleImport = useCallback(async () => {
    if (!inspection || !authorPreview) return
    setImporting(true)
    try {
      const project = useProjectStore.getState().currentProject
      const projectSession = captureProjectSession(project)
      if (!project || !projectSession) {
        throw new Error(text('目标项目缺少有效会话', 'The target project has no valid session.'))
      }

      const prepareRequest: ImportRunPrepareFromInspectionRequest = {
        runId: randomUUID(),
        inspectionId: inspection.inspectionId,
        purpose: 'author-manuscript',
        locale,
        authorityFingerprint: authorPreview.authorityFingerprint,
        manifestFingerprint: authorPreview.manifestFingerprint,
      }

      const prepared = await ipc.invokeWithProjectSession(
        projectSession,
        'db:import-run-prepare-inspection',
        prepareRequest,
        project.path,
      )

      if (!prepared.success) {
        throw new Error(
          prepared.errorCode === AUTHOR_IMPORT_PREVIEW_STALE
            ? text('项目或原稿清单已变化，请重新选择文件并确认预览。', 'Manuscript or project changed. Select files again.')
            : prepared.error || text('无法创建导入运行', 'Could not create import run.'),
        )
      }

      setInspection(null)
      setSplitDone(false)
      const preparation = prepared.preparation

      if (preparation.classification === 'exact-duplicate') {
        setImportNotice(text('这些章节已是相同的权威定稿；未重复发布。', 'Chapters already exist as identical finalized text.'))
        return
      }
      if (preparation.classification === 'conflict') {
        setSplitError(text('章节与现有权威正文冲突，请修正后重试。', 'Chapters conflict with authoritative text.'))
        return
      }
      if (!preparation.run) throw new Error(text('导入缺少持久化记录', 'Missing import run record.'))
      await launchRun(preparation.run)
    } catch (e) {
      setInspection(null)
      setAuthorPreview(null)
      setSplitDone(false)
      setSplitError(String(e))
    } finally {
      setImporting(false)
    }
  }, [authorPreview, inspection, launchRun, locale, text])

  const handleResume = useCallback(async () => {
    if (!resumableRun) return
    setImporting(true)
    try {
      await launchRun(resumableRun)
    } catch (e) {
      setSplitError(String(e))
    } finally {
      setImporting(false)
    }
  }, [launchRun, resumableRun])

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText size={18} className="text-[var(--color-accent)]" />
            {text('导入作者原稿', 'Import Author Manuscript')}
          </DialogTitle>
          <DialogDescription>
            {text(
              '选择我的原稿文件，按章节号导入为当前项目的不可变权威定稿；不会进入参考语料或触发仿写拆解。',
              'Import your manuscript files by chapter number as immutable authoritative finalized chapters.',
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
          {!currentProject && (
            <div className="p-3 rounded-lg text-xs" style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-error-text)' }}>
              {text('请先打开或创建项目，再导入作者原稿。', 'Open or create a project before importing manuscript.')}
            </div>
          )}

          {currentProject && (
            <div className="text-xs text-[var(--color-text-secondary)]">
              {text(`当前项目：${currentProject.name}`, `Current project: ${currentProject.name}`)}
            </div>
          )}

          {resumableRun && (
            <div
              className="rounded-lg p-3 space-y-2 text-xs"
              style={{ border: '1px solid var(--color-warning)', backgroundColor: 'var(--color-hover)' }}
            >
              <div className="flex items-center gap-1.5 font-medium">
                <RotateCcw size={13} />
                {text('存在未完成的原稿导入', 'Unfinished manuscript import available')}
              </div>
              <div className="flex items-center justify-between">
                <span>{resumableRun.sourceDisplay?.[0]?.displayName ?? resumableRun.id}</span>
                <span>{resumableRun.completedChapters}/{resumableRun.totalChapters} 章</span>
              </div>
              <Button size="sm" onClick={handleResume} disabled={importing || resumableRunIsActive}>
                {text('继续导入', 'Continue Import')}
              </Button>
            </div>
          )}

          <div>
            <Label>{text('选择原稿文件', 'Select Manuscript Files')}</Label>
            <div className="flex gap-2">
              <div
                className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg text-xs truncate"
                style={{
                  backgroundColor: 'var(--color-input)',
                  border: '1px solid var(--color-border)',
                  color: inspection ? 'var(--color-text)' : 'var(--color-text-muted)',
                }}
              >
                <FileText size={14} className="shrink-0" />
                {inspection
                  ? text(`${inspection.sourceCount} 个文件已选择`, `${inspection.sourceCount} files selected`)
                  : text('支持 .txt / .md / .epub 文件', 'Supports .txt / .md / .epub files')}
              </div>
              <Button variant="outline" onClick={() => void handleSelectFiles()} disabled={splitting || !currentProject}>
                <FolderOpen size={14} />
                {text('选择', 'Choose')}
              </Button>
            </div>
          </div>

          {splitting && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs" style={{ backgroundColor: 'var(--color-hover)' }}>
              <div className="animate-spin w-3 h-3 border-2 border-current border-t-transparent rounded-full" />
              {text('正在拆章并核对正文连续性...', 'Splitting chapters and checking continuity...')}
            </div>
          )}

          {splitError && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs" style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-error-text)' }}>
              <AlertTriangle size={14} />
              {splitError}
            </div>
          )}

          {importNotice && (
            <div className="px-3 py-2 rounded-lg text-xs" style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text-secondary)' }}>
              {importNotice}
            </div>
          )}

          {splitDone && inspection && authorPreview && (
            <div className="rounded-lg overflow-hidden border border-[var(--color-border)]">
              <div className="flex items-center gap-4 px-3 py-2 text-xs font-medium bg-[var(--color-hover)]">
                <span>{text(`共 ${inspection.chapterCount} 章`, `${inspection.chapterCount} chapters`)}</span>
                <span className="text-[var(--color-text-muted)]">{text(`${inspection.totalWords.toLocaleString()} 字`, `${inspection.totalWords.toLocaleString()} words`)}</span>
              </div>
              <div className="px-3 py-2 space-y-1 max-h-40 overflow-y-auto">
                {authorPreview.chapters.map((ch) => (
                  <div key={ch.number} className="flex items-center justify-between text-xs">
                    <span className="truncate flex-1 text-[var(--color-text-secondary)]">
                      {text(`第${ch.number}章 ${ch.title}`, `Ch ${ch.number} ${ch.title}`)}
                    </span>
                    <span className="text-[0.7rem] px-1.5 py-0.5 rounded bg-[var(--color-bg-secondary)]">
                      {ch.disposition === 'new'
                        ? text('定稿', 'Finalized')
                        : ch.disposition === 'duplicate'
                          ? text('重复', 'Duplicate')
                          : text('冲突', 'Conflict')}
                    </span>
                  </div>
                ))}
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
              || authorPreviewLoading
              || !authorPreview
              || authorPreview.classification === 'conflict'
              || !currentProject
            }
          >
            {importing ? text('导入中...', 'Importing...') : text(`确认导入定稿（${inspection?.chapterCount ?? 0} 章）`, `Confirm Import (${inspection?.chapterCount ?? 0} chapters)`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
