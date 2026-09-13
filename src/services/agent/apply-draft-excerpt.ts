import { countDraftUnits } from '../../shared/draft-units'
import type { RendererActionResult } from '../../shared/agent-events'
import { replaceExactOnce } from '../../shared/draft-excerpt'
import { projectSessionContextFromProject } from '../../shared/project-session-context'
import { ipc } from '../ipc-client'
import { requireIpcSuccess } from '../ipc-result'
import { useEditorStore } from '../../stores/editor-store'
import { useProjectStore } from '../../stores/project-store'
import { useLocaleStore } from '../../stores/locale-store'

export interface ReplaceDraftExcerptRequest {
  chapterNumber: number
  oldText: string
  newText: string
  draftId?: number
}

function findDraftTab(request: ReplaceDraftExcerptRequest, projectPath: string) {
  return useEditorStore.getState().tabs.find((tab) => {
    if (tab.projectKey !== projectPath || tab.type !== 'chapter') return false
    if (request.draftId != null && tab.draftId === request.draftId) return true
    if (tab.chapterNumber === request.chapterNumber) return true
    if (tab.filePath === `vela://draft/${request.draftId}`) return true
    return false
  })
}

export async function applyDraftExcerptReplace(
  request: ReplaceDraftExcerptRequest,
): Promise<RendererActionResult> {
  const text = useLocaleStore.getState().text
  const project = useProjectStore.getState().currentProject
  const session = projectSessionContextFromProject(project)
  if (!project || !session) {
    return { ok: false, error: text('未打开项目，无法修改草稿。', 'No project is open, so the draft was not changed.') }
  }
  const oldText = request.oldText
  const newText = request.newText
  if (!oldText) {
    return { ok: false, error: text('缺少要替换的原文。', 'The original excerpt is missing.') }
  }

  const tab = findDraftTab(request, project.path)
  if (tab?.draftStatus === 'finalized' || tab?.draftStatus === 'archived') {
    return { ok: false, error: text('已定稿正文为只读，不能局部替换。', 'A finalized draft is read-only and cannot be patched.') }
  }

  let draftId = request.draftId ?? tab?.draftId
  let body = tab?.content
  if (body == null || draftId == null) {
    if (draftId == null) {
      const latest = await ipc.invokeWithProjectSession(
        session,
        'db:draft-get-latest',
        request.chapterNumber,
        project.path,
      )
      draftId = latest && typeof latest === 'object' && 'id' in latest
        ? Number((latest as { id: number }).id)
        : undefined
    }
    if (draftId == null) {
      return { ok: false, error: text(
        `第 ${request.chapterNumber} 章没有可修改的草稿。`,
        `Chapter ${request.chapterNumber} has no editable draft.`,
      ) }
    }
    const full = await ipc.invokeWithProjectSession(session, 'db:draft-get-full', draftId, project.path)
    if (!full || typeof full.content !== 'string') {
      return { ok: false, error: text('读取草稿失败。', 'Could not read the draft.') }
    }
    if (full.status === 'finalized' || full.status === 'archived') {
      return { ok: false, error: text('已定稿正文为只读，不能局部替换。', 'A finalized draft is read-only and cannot be patched.') }
    }
    body = body ?? full.content
    draftId = full.id
  }

  const replaced = replaceExactOnce(body, oldText, newText)
  if (!replaced.ok) {
    if (replaced.reason === 'not_found') {
      return { ok: false, error: text(
        '草稿中找不到这段原文。请用工具再读一次当前正文，复制完全相同的片段后再替换。',
        'That excerpt was not found in the draft. Read the current body and copy the exact text before replacing.',
      ) }
    }
    if (replaced.reason === 'ambiguous') {
      return { ok: false, error: text(
        '这段原文在草稿中出现了不止一次。请多复制前后文，使匹配唯一。',
        'That excerpt occurs more than once. Include more surrounding text so it matches exactly once.',
      ) }
    }
    return { ok: false, error: text('替换原文不能为空。', 'The original excerpt cannot be empty.') }
  }

  const wordCount = countDraftUnits(replaced.next)
  const saved = await ipc.invokeWithProjectSession(
    session,
    'db:draft-update-content',
    draftId,
    replaced.next,
    wordCount,
    project.path,
  )
  requireIpcSuccess(saved, text('保存局部替换', 'Save the passage replacement'))

  const openTab = findDraftTab({ ...request, draftId }, project.path)
  if (openTab) {
    useEditorStore.getState().syncTabContent(openTab.id, replaced.next)
    useEditorStore.getState().markTabSaved(openTab.id, replaced.next)
  }

  return {
    ok: true,
    summary: text(
      `已在第 ${request.chapterNumber} 章草稿中替换一处原文（${oldText.length} → ${newText.length} 字）。`,
      `Replaced one excerpt in chapter ${request.chapterNumber} (${oldText.length} → ${newText.length} characters).`,
    ),
  }
}
