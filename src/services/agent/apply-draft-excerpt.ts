import { countDraftUnits } from '../../shared/draft-units'
import type { RendererActionResult } from '../../shared/agent-events'
import {
  batchReplaceExcerpts,
  type ExcerptReplacementItem,
} from '../../shared/draft-excerpt'
import { projectSessionContextFromProject } from '../../shared/project-session-context'
import { ipc } from '../ipc-client'
import { requireIpcSuccess } from '../ipc-result'
import { useEditorStore } from '../../stores/editor-store'
import { useProjectStore } from '../../stores/project-store'
import { useLocaleStore } from '../../stores/locale-store'

export interface ReplaceDraftExcerptRequest {
  chapterNumber: number
  oldText?: string
  newText?: string
  replacements?: ExcerptReplacementItem[]
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

  // 规范化替换列表（兼容单个 oldText/newText 与批量 replacements 数组）
  const items: ExcerptReplacementItem[] = []
  if (Array.isArray(request.replacements) && request.replacements.length > 0) {
    for (const r of request.replacements) {
      if (r && typeof r.old_text === 'string') {
        items.push({ old_text: r.old_text, new_text: r.new_text ?? '' })
      }
    }
  } else if (typeof request.oldText === 'string' && request.oldText) {
    items.push({ old_text: request.oldText, new_text: request.newText ?? '' })
  }

  if (items.length === 0) {
    return { ok: false, error: text('缺少要替换的原文 old_text 或 replacements 列表。', 'old_text or replacements list is required.') }
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

  const replaced = batchReplaceExcerpts(body, items)
  if (!replaced.ok) {
    return { ok: false, error: replaced.message }
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

  const summaryHeader = text(
    `已成功在第 ${request.chapterNumber} 章草稿中替换 ${replaced.count} 处正文：\n\n`,
    `Successfully replaced ${replaced.count} passage(s) in chapter ${request.chapterNumber}:\n\n`,
  )
  const previewsText = replaced.previews
    .map((p, idx) => `[改动 ${idx + 1} 局部上下文预览]：\n${p}`)
    .join('\n\n')

  return {
    ok: true,
    summary: `${summaryHeader}${previewsText}`,
  }
}
