import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type, StringEnum } from '@earendil-works/pi-ai'

import { DraftRepository, type DraftMeta } from '../../repositories/draft-repository'
import { DraftAnnotationRepository } from '../../repositories/draft-annotation-repository'
import { countDraftUnits } from '../../../src/shared/draft-units'
import { MAX_DRAFT_EXCERPT_CHARS } from '../../../src/shared/draft-excerpt'
import type { DraftAnnotation } from '../../../src/shared/draft-annotation'
import { getCurrentProjectPath, getProjectDb } from '../../database'
import type { RendererActionSink } from '../renderer-action'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

export const DRAFT_ACTIONS = [
  'read',
  'write',
  'replace_excerpt',
  'list_versions',
  'list_annotations',
  'resolve_annotation',
  'delete',
] as const

export const DRAFT_TYPES = ['latest', 'draft_v1', 'revised'] as const
export const WRITE_MODES = ['new_version', 'overwrite'] as const

type DraftAction = typeof DRAFT_ACTIONS[number]
type LanguageText = (zhCN: string, enUS: string) => string

type DraftReplacement = {
  old_text: string
  new_text: string
}

type ManageDraftsParams = {
  action?: string
  chapter_number: number
  draft_type?: string
  version?: number
  offset?: number
  limit?: number
  content?: string
  mode?: string
  old_text?: string
  new_text?: string
  replacements?: DraftReplacement[]
  annotation_id?: string
  resolve_all?: boolean
  draft_id?: number
}

type ToolOutput = {
  content: Array<{ type: 'text'; text: string }>
  details: unknown
}

type DraftToolContext = {
  text: LanguageText
  isEn: boolean
  rendererAction: RendererActionSink
  chapterNumber: number
  params: ManageDraftsParams
}

const Schema = Type.Object({
  action: Type.Optional(StringEnum(DRAFT_ACTIONS, {
    description: 'Operation action: "read" (read draft body with pending annotations, default), "write" (create new draft or rewrite whole chapter), "replace_excerpt" (precisely replace passage), "list_versions" (list chapter draft versions), "list_annotations" (inspect annotations), "resolve_annotation" (mark annotation resolved), "delete" (delete unfinalized draft).',
  })),
  chapter_number: Type.Integer({ minimum: 1, description: '目标章节序号（正整数，如 1 代表第 1 章）' }),

  // === read 参数 ===
  draft_type: Type.Optional(StringEnum(DRAFT_TYPES, {
    description: 'Draft type to read: "latest" (default), "draft_v1" (initial draft), or "revised" (revised draft).',
  })),
  version: Type.Optional(Type.Integer({ minimum: 1, description: '指定的草稿版本号（如 1、2、3）' })),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: '读取起始行号（从 1 开始）' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: '单次读取的最大行数' })),

  // === write 参数 ===
  content: Type.Optional(Type.String({ description: '要写入的完整草稿正文内容（write 操作必填）' })),
  mode: Type.Optional(StringEnum(WRITE_MODES, {
    description: 'Write mode: "new_version" (create new version v2/v3, recommended default) or "overwrite" (overwrite unfinalized draft).',
  })),

  // === replace_excerpt 参数 ===
  old_text: Type.Optional(Type.String({ description: '单处替换：要被替换的原文片段（必须唯一存在）' })),
  new_text: Type.Optional(Type.String({ description: '单处替换：替换后的新正文片段（润色、扩写或修改后的段落）' })),
  replacements: Type.Optional(Type.Array(
    Type.Object({
      old_text: Type.String({ description: '要替换的原文片段（必须唯一匹配）' }),
      new_text: Type.String({ description: '替换后的新段落内容' }),
    }),
    { description: '批量替换列表（一次性原子应用全章多处修改，优先于单组 old_text/new_text）' },
  )),

  // === resolve_annotation 参数 ===
  annotation_id: Type.Optional(Type.String({ description: '要标记已解决的批注 ID（resolve_annotation 操作使用）' })),
  resolve_all: Type.Optional(Type.Boolean({ description: '是否将本章所有未解决批注一次性标记为已解决（resolve_annotation 操作使用）' })),

  // === 通用版本指定 / 删除参数 ===
  draft_id: Type.Optional(Type.Integer({ minimum: 1, description: '可选的具体草稿版本数据库 ID（delete 操作必填）' })),
})

function textOutput(body: string, details: unknown): ToolOutput {
  return {
    content: [{ type: 'text', text: body }],
    details,
  }
}

function requireOpenProject(text: LanguageText): void {
  if (!getCurrentProjectPath()) {
    throw new Error(text('未打开小说项目', 'No novel project is currently open'))
  }
  if (!getProjectDb()) {
    throw new Error(text('项目数据库未初始化', 'Project database is not initialized'))
  }
}

function resolveDraftAction(rawAction: string): DraftAction {
  if (rawAction === 'list_versions' || rawAction === '版本清单' || rawAction === '查看版本') {
    return 'list_versions'
  }
  if (rawAction === 'list_annotations' || rawAction === '查看标注' || rawAction === '标注列表' || rawAction === '批注') {
    return 'list_annotations'
  }
  if (rawAction === 'replace_excerpt' || rawAction === '局部替换' || rawAction === '修改段落' || rawAction === '润色') {
    return 'replace_excerpt'
  }
  if (rawAction === 'resolve_annotation' || rawAction === '解决批注' || rawAction === '解决标注' || rawAction === '归档批注') {
    return 'resolve_annotation'
  }
  if (rawAction === 'delete' || rawAction === '删除') {
    return 'delete'
  }
  if (rawAction === 'write' || rawAction === '新建' || rawAction === '重写' || rawAction === '保存草稿') {
    return 'write'
  }
  return 'read'
}

function formatDraftStatus(status: string, isEn: boolean): string {
  switch (status) {
    case 'draft': return isEn ? 'Draft' : '草稿'
    case 'revised': return isEn ? 'Revised' : '已修订'
    case 'finalized': return isEn ? 'Finalized' : '已定稿'
    case 'archived': return isEn ? 'Archived' : '已归档'
    default: return status
  }
}

function formatAnnotationLine(item: DraftAnnotation, index: number, text: LanguageText): string {
  return text(
    `${index + 1}. 原文选区：「${item.quote.trim()}」\n   作者意见：${item.note.trim()}`,
    `${index + 1}. Original: "${item.quote.trim()}"\n   Author Note: ${item.note.trim()}`,
  )
}

function annotationSummaries(annotations: DraftAnnotation[]): Array<{ id: string; quote: string; note: string }> {
  return annotations.map(function (item) {
    return { id: item.id, quote: item.quote, note: item.note }
  })
}

async function syncDraftContent(
  rendererAction: RendererActionSink,
  chapterNumber: number,
  draftId: number,
  content: string,
  isNewVersion: boolean,
): Promise<void> {
  await rendererAction({
    type: 'sync_draft_content',
    chapterNumber,
    draftId,
    content,
    isNewVersion,
  })
}

function resolveListedDraft(chapterNumber: number, params: ManageDraftsParams, drafts: DraftMeta[]): DraftMeta | null | undefined {
  if (params.draft_id) {
    return DraftRepository.getMeta(params.draft_id)
  }
  if (params.version !== undefined) {
    return drafts.find(function (draft) {
      return draft.version === params.version
    })
  }
  return DraftRepository.getLatestByChapter(chapterNumber)
}

function resolveReadDraft(
  chapterNumber: number,
  drafts: DraftMeta[],
  params: ManageDraftsParams,
  text: LanguageText,
): DraftMeta {
  if (params.version !== undefined) {
    const match = drafts.find(function (draft) {
      return draft.version === params.version
    })
    if (!match) {
      throw new Error(text(
        `第 ${chapterNumber} 章未找到版本 v${params.version}。当前可用版本：${drafts.map(function (draft) { return `v${draft.version}` }).join('、')}`,
        `Draft v${params.version} not found for chapter ${chapterNumber}. Available versions: ${drafts.map(function (draft) { return `v${draft.version}` }).join(', ')}`,
      ))
    }
    return match
  }

  const rawType = params.draft_type || 'latest'
  let targetMeta: DraftMeta | null | undefined
  if (rawType === 'draft_v1') {
    targetMeta = drafts.find(function (draft) { return draft.version === 1 }) ?? drafts[0]
  } else if (rawType === 'revised') {
    targetMeta = drafts.find(function (draft) {
      return draft.status === 'revised' || draft.version > 1
    }) ?? drafts[drafts.length - 1]
  } else {
    targetMeta = DraftRepository.getLatestByChapter(chapterNumber) ?? drafts[drafts.length - 1]
  }

  if (!targetMeta) {
    throw new Error(text(`未找到第 ${chapterNumber} 章对应的草稿`, `Could not find draft for chapter ${chapterNumber}`))
  }
  return targetMeta
}

function handleListVersions(ctx: DraftToolContext): ToolOutput {
  const { chapterNumber, text, isEn } = ctx
  const drafts = DraftRepository.listByChapter(chapterNumber)
  if (drafts.length === 0) {
    return textOutput(
      text(
        `第 ${chapterNumber} 章暂无任何草稿记录。可使用 action: "write" 为该章撰写首版草稿。`,
        `Chapter ${chapterNumber} currently has no drafts. Use action: "write" to create the initial draft.`,
      ),
      { chapterNumber, totalVersions: 0, versions: [] },
    )
  }

  const lines: string[] = [
    text(`### 第 ${chapterNumber} 章草稿版本清单（共 ${drafts.length} 版）：\n`, `### Draft Versions for Chapter ${chapterNumber} (${drafts.length} versions):\n`),
  ]
  for (const draft of drafts) {
    const statusText = formatDraftStatus(draft.status, isEn)
    lines.push(
      `- **Draft v${draft.version}** (ID: ${draft.id}) · 状态: [${statusText}] · 字数: ${draft.wordCount} 字 · 来源: ${draft.source} · 更新时间: ${draft.updatedAt || draft.createdAt}`,
    )
  }

  return textOutput(lines.join('\n'), {
    chapterNumber,
    totalVersions: drafts.length,
    versions: drafts.map(function (draft) {
      return { id: draft.id, version: draft.version, status: draft.status, wordCount: draft.wordCount }
    }),
  })
}

function handleListAnnotations(ctx: DraftToolContext): ToolOutput {
  const { chapterNumber, params, text } = ctx
  const allDrafts = DraftRepository.listByChapter(chapterNumber)
  if (allDrafts.length === 0) {
    return textOutput(
      text(
        `第 ${chapterNumber} 章暂无任何草稿记录。`,
        `Chapter ${chapterNumber} currently has no drafts.`,
      ),
      { chapterNumber, totalAnnotations: 0, annotations: [] },
    )
  }

  const targetMeta = resolveListedDraft(chapterNumber, params, allDrafts)
  if (!targetMeta) {
    throw new Error(text(`未找到第 ${chapterNumber} 章对应的草稿版本`, `Could not find draft for chapter ${chapterNumber}`))
  }

  const annotations = DraftAnnotationRepository.list(targetMeta.id)
  if (annotations.length === 0) {
    return textOutput(
      text(
        `第 ${chapterNumber} 章（Draft v${targetMeta.version}）目前暂无作者划词标注意见。`,
        `Chapter ${chapterNumber} (Draft v${targetMeta.version}) currently has no author annotations.`,
      ),
      { chapterNumber, draftId: targetMeta.id, version: targetMeta.version, totalAnnotations: 0, annotations: [] },
    )
  }

  const lines: string[] = [
    text(
      `### 第 ${chapterNumber} 章作者划词标注清单（Draft v${targetMeta.version} · 共 ${annotations.length} 处修改意见）：\n`,
      `### Author Passage Notes for Chapter ${chapterNumber} (Draft v${targetMeta.version} · ${annotations.length} notes):\n`,
    ),
  ]
  annotations.forEach(function (item, index) {
    lines.push(formatAnnotationLine(item, index, text))
  })
  lines.push(
    text(
      `\n（修改提示：可直接调用 action: "replace_excerpt"，将上述「原文选区」作为 old_text，输入修改后的 new_text 完成针对性润色替换）`,
      `\n(Tip: Call action: "replace_excerpt" using the original quote as old_text to apply targeted changes)`,
    ),
  )

  return textOutput(lines.join('\n'), {
    chapterNumber,
    draftId: targetMeta.id,
    version: targetMeta.version,
    totalAnnotations: annotations.length,
    annotations: annotationSummaries(annotations),
  })
}

async function handleReplaceExcerpt(ctx: DraftToolContext): Promise<ToolOutput> {
  const { chapterNumber, params, text, rendererAction } = ctx
  const replacements = params.replacements
  const hasBatch = Array.isArray(replacements) && replacements.length > 0
  const oldText = params.old_text ?? ''
  const newText = params.new_text ?? ''

  if (!hasBatch && !oldText) {
    throw new Error(text('缺少要替换的原文 old_text 或 replacements 批量列表', 'old_text or replacements list is required for replace_excerpt'))
  }

  if (hasBatch) {
    for (let i = 0; i < replacements.length; i++) {
      const item = replacements[i]
      if (!item.old_text || !item.old_text.trim()) {
        throw new Error(text(`第 ${i + 1} 项要替换的原文 old_text 不能为空`, `Item ${i + 1} old_text cannot be empty`))
      }
      if (item.old_text.length > MAX_DRAFT_EXCERPT_CHARS || (item.new_text && item.new_text.length > MAX_DRAFT_EXCERPT_CHARS)) {
        throw new Error(text(
          `第 ${i + 1} 项替换片段过长（单处最多 ${MAX_DRAFT_EXCERPT_CHARS} 字）`,
          `Item ${i + 1} excerpt is too long (max ${MAX_DRAFT_EXCERPT_CHARS} characters)`,
        ))
      }
    }
  } else if (oldText.length > MAX_DRAFT_EXCERPT_CHARS || newText.length > MAX_DRAFT_EXCERPT_CHARS) {
    throw new Error(text(
      `替换片段过长（最多 ${MAX_DRAFT_EXCERPT_CHARS} 字）`,
      `The excerpt is too long (max ${MAX_DRAFT_EXCERPT_CHARS} characters)`,
    ))
  }

  const outcome = await rendererAction({
    type: 'replace_draft_excerpt',
    chapterNumber,
    oldText: hasBatch ? undefined : oldText,
    newText: hasBatch ? undefined : newText,
    replacements: hasBatch ? replacements : undefined,
    draftId: params.draft_id,
  })

  if (!outcome || !outcome.ok) {
    let reason = text('局部替换失败', 'Failed to replace excerpt')
    if (outcome && 'error' in outcome && outcome.error) {
      reason = outcome.error
    }
    throw new Error(reason)
  }

  return textOutput(outcome.summary, {
    chapterNumber,
    batchCount: hasBatch ? replacements.length : 1,
  })
}

async function handleResolveAnnotation(ctx: DraftToolContext): Promise<ToolOutput> {
  const { chapterNumber, params, text, rendererAction } = ctx
  const allDrafts = DraftRepository.listByChapter(chapterNumber)
  if (allDrafts.length === 0) {
    throw new Error(text(`第 ${chapterNumber} 章暂无草稿`, `No draft found for chapter ${chapterNumber}`))
  }

  const targetMeta = params.draft_id
    ? DraftRepository.getMeta(params.draft_id)
    : DraftRepository.getLatestByChapter(chapterNumber)
  if (!targetMeta) {
    throw new Error(text(`未找到第 ${chapterNumber} 章对应的草稿`, `Could not find draft for chapter ${chapterNumber}`))
  }
  if (!params.resolve_all && !params.annotation_id) {
    throw new Error(text('resolve_annotation 必须提供 annotation_id 或 resolve_all: true', 'annotation_id or resolve_all: true is required for resolve_annotation'))
  }

  let resolvedCount = 0
  if (params.resolve_all) {
    resolvedCount = DraftAnnotationRepository.resolve(targetMeta.id, 'all')
  } else if (params.annotation_id) {
    resolvedCount = DraftAnnotationRepository.resolve(targetMeta.id, [params.annotation_id])
  }

  await syncDraftContent(rendererAction, chapterNumber, targetMeta.id, '', false)

  return textOutput(
    text(
      `已成功将第 ${chapterNumber} 章（Draft v${targetMeta.version}）的 ${resolvedCount} 处作者批注标记为已解决并归档。\n下次调用 read 或 list_annotations 时将不再展示已解决项。`,
      `Successfully resolved ${resolvedCount} annotation(s) for chapter ${chapterNumber} (Draft v${targetMeta.version}).`,
    ),
    { chapterNumber, draftId: targetMeta.id, resolvedCount },
  )
}

async function handleDelete(ctx: DraftToolContext): Promise<ToolOutput> {
  const { chapterNumber, params, text, rendererAction } = ctx
  const draftId = params.draft_id
  if (!draftId) {
    throw new Error(text('删除草稿必须指定 draft_id。可先使用 action: "list_versions" 查询草稿 ID。', 'draft_id is required for delete. Use action: "list_versions" first.'))
  }

  const meta = DraftRepository.getMeta(draftId)
  if (!meta) {
    throw new Error(text(`未找到 ID 为 ${draftId} 的草稿`, `Draft with ID ${draftId} not found`))
  }
  if (meta.chapterNumber !== chapterNumber) {
    throw new Error(text(`草稿 ID ${draftId} 属于第 ${meta.chapterNumber} 章，与请求的第 ${chapterNumber} 章不符`, `Draft ID ${draftId} belongs to chapter ${meta.chapterNumber}, not chapter ${chapterNumber}`))
  }
  if (meta.status === 'finalized') {
    throw new Error(text('已定稿草稿为不可变最终事实，严禁删除。', 'Finalized drafts are immutable and cannot be deleted.'))
  }

  DraftRepository.delete(draftId)
  await syncDraftContent(rendererAction, chapterNumber, draftId, '', false)

  return textOutput(
    text(
      `已成功删除第 ${chapterNumber} 章的草稿（Draft v${meta.version}, ID: ${draftId}）。`,
      `Deleted draft v${meta.version} (ID: ${draftId}) of chapter ${chapterNumber}.`,
    ),
    { chapterNumber, deletedId: draftId, version: meta.version },
  )
}

async function handleWrite(ctx: DraftToolContext): Promise<ToolOutput> {
  const { chapterNumber, params, text, rendererAction } = ctx
  const content = (params.content || '').trim()
  if (!content) {
    throw new Error(text('写入草稿必须提供非空正文 content', 'content is required for write'))
  }

  const wordCount = countDraftUnits(content)
  const existingDrafts = DraftRepository.listByChapter(chapterNumber)
  const mode = params.mode || 'new_version'

  if (mode === 'overwrite' && existingDrafts.length > 0) {
    const targetMeta = params.draft_id
      ? DraftRepository.getMeta(params.draft_id)
      : DraftRepository.getLatestByChapter(chapterNumber)
    if (!targetMeta) {
      throw new Error(text('未找到要覆盖的草稿版本', 'No draft found to overwrite'))
    }
    if (targetMeta.status === 'finalized') {
      throw new Error(text(
        `第 ${chapterNumber} 章 Draft v${targetMeta.version} 已经定稿锁定，严禁覆盖修改。\n如需重写该章，请使用 mode: "new_version" 生成新版草稿，或者在界面中解除定稿。`,
        `Chapter ${chapterNumber} draft v${targetMeta.version} is finalized and locked. Use mode: "new_version" instead.`,
      ))
    }

    DraftRepository.updateContent(targetMeta.id, content, wordCount)
    DraftAnnotationRepository.replace(targetMeta.id, [])
    await syncDraftContent(rendererAction, chapterNumber, targetMeta.id, content, false)

    return textOutput(
      text(
        `已成功全量更新第 ${chapterNumber} 章草稿（Draft v${targetMeta.version}，共 ${wordCount} 字）。正文编辑器与草稿箱已即时同步。`,
        `Successfully updated chapter ${chapterNumber} draft v${targetMeta.version} (${wordCount} words).`,
      ),
      { chapterNumber, draftId: targetMeta.id, version: targetMeta.version, wordCount, mode: 'overwrite' },
    )
  }

  const source = existingDrafts.length > 0 ? 'rewrite' : 'write'
  const newDraftId = DraftRepository.create({
    chapterNumber,
    source,
    content,
    wordCount,
  })
  const newMeta = DraftRepository.getMeta(newDraftId)
  const newVersion = newMeta?.version ?? (existingDrafts.length + 1)
  await syncDraftContent(rendererAction, chapterNumber, newDraftId, content, true)

  return textOutput(
    text(
      `已成功为第 ${chapterNumber} 章生成新草稿（Draft v${newVersion}，共 ${wordCount} 字，ID: ${newDraftId}）。\n草稿已入库并在草稿箱中就绪。`,
      `Successfully created new draft v${newVersion} for chapter ${chapterNumber} (${wordCount} words, ID: ${newDraftId}).`,
    ),
    { chapterNumber, draftId: newDraftId, version: newVersion, wordCount, mode: 'new_version' },
  )
}

function handleRead(ctx: DraftToolContext): ToolOutput {
  const { chapterNumber, params, text, isEn } = ctx
  const allDrafts = DraftRepository.listByChapter(chapterNumber)
  if (allDrafts.length === 0) {
    throw new Error(text(
      `第 ${chapterNumber} 章暂无任何草稿。建议调用 manage_drafts (action: "write") 为该章撰写首版正文。`,
      `No draft found for chapter ${chapterNumber}. Use manage_drafts (action: "write") to create one.`,
    ))
  }

  const targetMeta = resolveReadDraft(chapterNumber, allDrafts, params, text)
  const fullDraft = DraftRepository.getFull(targetMeta.id)
  if (!fullDraft) {
    throw new Error(text('读取草稿正文失败，内容表记录缺失', 'Could not read draft content body'))
  }

  const lines = fullDraft.content.split('\n')
  const totalLines = lines.length
  const offset = params.offset ?? 1
  const limit = params.limit ?? 200
  const startIdx = Math.max(0, offset - 1)
  const endIdx = Math.min(totalLines, startIdx + limit)
  const visibleLines = lines.slice(startIdx, endIdx)
  const formatted = visibleLines.map(function (line, idx) {
    const lineNo = startIdx + idx + 1
    return `${String(lineNo).padStart(4, ' ')} | ${line}`
  }).join('\n')

  const statusLabel = formatDraftStatus(targetMeta.status, isEn)
  const header = text(
    `### 第 ${chapterNumber} 章正文草稿（Draft v${targetMeta.version} · 状态: ${statusLabel} · 共 ${targetMeta.wordCount} 字 · 展示行 ${startIdx + 1}–${endIdx} / 总 ${totalLines} 行）：\n\n`,
    `### Chapter ${chapterNumber} Draft (v${targetMeta.version} · Status: ${statusLabel} · ${targetMeta.wordCount} words · Lines ${startIdx + 1}–${endIdx} of ${totalLines}):\n\n`,
  )

  const annotations = DraftAnnotationRepository.list(targetMeta.id)
  let annotationsSection = ''
  if (annotations.length > 0) {
    const annotationLines = annotations.map(function (item, idx) {
      return formatAnnotationLine(item, idx, text)
    })
    annotationsSection = text(
      `### 本章作者划词标注（修改意见 · 共 ${annotations.length} 处）：\n${annotationLines.join('\n')}\n（提示：可直接调用 action: "replace_excerpt" 传入上述原文进行定向修改）\n\n---\n\n`,
      `### Author Passage Notes (${annotations.length} notes):\n${annotationLines.join('\n')}\n(Tip: Call action: "replace_excerpt" with the original quote to apply changes)\n\n---\n\n`,
    )
  }

  return textOutput(header + annotationsSection + formatted, {
    chapterNumber,
    draftId: targetMeta.id,
    version: targetMeta.version,
    status: targetMeta.status,
    wordCount: targetMeta.wordCount,
    totalLines,
    offset: startIdx + 1,
    limit: visibleLines.length,
    annotationsCount: annotations.length,
    annotations: annotationSummaries(annotations),
  })
}

/** 判定某次 manage_drafts 调用是否为写入操作。 */
export function isManageDraftsWrite(params: Record<string, unknown>): boolean {
  const rawAction = String(params.action || 'read').toLowerCase().trim()
  const action = resolveDraftAction(rawAction)
  return action === 'write' || action === 'replace_excerpt' || action === 'delete'
}

export function createManageDraftsTool(
  language: WritingLanguage,
  rendererAction: RendererActionSink,
): AgentTool<typeof Schema> {
  const isEn = language === 'en-US'
  function text(zhCN: string, enUS: string): string {
    return writingLanguageText(language, zhCN, enUS)
  }

  const description = isEn
    ? 'All-in-one Chapter Draft Tool: read drafts with active author annotations; batch or single replace passages with surrounding context previews and whitespace tolerance; write or rewrite complete drafts; resolve/archive addressed annotations; view versions; and delete unfinalized drafts.'
    : '全功能草稿中枢工具：支持读取草稿正文及待处理的作者划词批注；支持单处或批量（replacements）精准替换正文，自动返回带行号的局部上下文预览切片，兼具换行与行末空白弱容错；支持新建首版草稿与整章推倒重写；支持将已改动的批注标记为已解决（resolve_annotation）归档；支持草稿版本清单查看与安全删除未定稿草稿。'

  return {
    name: 'manage_drafts',
    label: 'Manage Drafts',
    description,
    parameters: Schema,
    isWriteOperation: isManageDraftsWrite,
    execute: async function execute(_id, params): Promise<ToolOutput> {
      requireOpenProject(text)

      const chapterNumber = params.chapter_number
      if (!Number.isInteger(chapterNumber) || chapterNumber < 1) {
        throw new Error(text('chapter_number 必须是从 1 开始的正整数', 'chapter_number must be an integer starting at 1'))
      }

      const ctx: DraftToolContext = {
        text,
        isEn,
        rendererAction,
        chapterNumber,
        params,
      }

      switch (resolveDraftAction(String(params.action || 'read').toLowerCase().trim())) {
        case 'list_versions':
          return handleListVersions(ctx)
        case 'list_annotations':
          return handleListAnnotations(ctx)
        case 'replace_excerpt':
          return handleReplaceExcerpt(ctx)
        case 'resolve_annotation':
          return handleResolveAnnotation(ctx)
        case 'delete':
          return handleDelete(ctx)
        case 'write':
          return handleWrite(ctx)
        default:
          return handleRead(ctx)
      }
    },
  }
}
