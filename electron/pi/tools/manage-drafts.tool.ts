import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { DraftRepository } from '../../repositories/draft-repository'
import { DraftAnnotationRepository } from '../../repositories/draft-annotation-repository'
import { countDraftUnits } from '../../../src/shared/draft-units'
import { MAX_DRAFT_EXCERPT_CHARS } from '../../../src/shared/draft-excerpt'
import { getCurrentProjectPath, getProjectDb } from '../../database'
import type { RendererActionSink } from '../renderer-action'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

const DraftAction = Type.Union([
  Type.Literal('read', { description: '读取草稿正文内容，自动附带未处理的作者划词标注列表（默认）' }),
  Type.Literal('write', { description: '整篇写草稿：为章节新建首版草稿、整章推倒重写（追加新版本）或覆盖未定稿草稿' }),
  Type.Literal('replace_excerpt', { description: '指定位置局部替换：精确替换章节草稿中的一段原文或多处原文（批量替换），自动返回上下文预览' }),
  Type.Literal('list_versions', { description: '查看章节拥有的所有草稿版本清单（版本号、字数、状态、创建时间）' }),
  Type.Literal('list_annotations', { description: '专项查询：仅查看本章当前草稿中作者留下的待处理划词批注与修改意见' }),
  Type.Literal('resolve_annotation', { description: '标记批注已解决：将已处理的作者划词批注标记归档（可传 annotation_id 或 resolve_all: true）' }),
  Type.Literal('delete', { description: '删除未定稿的草稿版本' }),
], { description: '操作类型' })

const DraftType = Type.Union([
  Type.Literal('latest', { description: '当前最新版本正文草稿（默认）' }),
  Type.Literal('draft_v1', { description: '章节初稿（第 1 版正文草稿）' }),
  Type.Literal('revised', { description: '修订润色稿' }),
], { description: '草稿版本类型' })

const WriteMode = Type.Union([
  Type.Literal('new_version', { description: '创建新版本草稿（如 Draft v2、v3），完整保留历史旧版本（推荐，整章重写默认）' }),
  Type.Literal('overwrite', { description: '直接全量覆盖当前未定稿的草稿正文（注意：已定稿章节受保护严禁覆盖）' }),
], { description: '整篇写入模式' })

const Schema = Type.Object({
  action: Type.Optional(DraftAction),
  chapter_number: Type.Integer({ minimum: 1, description: '目标章节序号（正整数，如 1 代表第 1 章）' }),

  // === read 参数 ===
  draft_type: Type.Optional(DraftType),
  version: Type.Optional(Type.Integer({ minimum: 1, description: '指定的草稿版本号（如 1、2、3）' })),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: '读取起始行号（从 1 开始）' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: '单次读取的最大行数' })),

  // === write 参数 ===
  content: Type.Optional(Type.String({ description: '要写入的完整草稿正文内容（write 操作必填）' })),
  mode: Type.Optional(WriteMode),

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

export function createManageDraftsTool(
  language: WritingLanguage,
  rendererAction: RendererActionSink,
): AgentTool<typeof Schema> {
  const isEn = language === 'en-US'
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)

  const description = isEn
    ? 'All-in-one Chapter Draft Tool: read drafts with active author annotations; batch or single replace passages with surrounding context previews and whitespace tolerance; write or rewrite complete drafts; resolve/archive addressed annotations; view versions; and delete unfinalized drafts.'
    : '全功能草稿中枢工具：支持读取草稿正文及待处理的作者划词批注；支持单处或批量（replacements）精准替换正文，自动返回带行号的局部上下文预览切片，兼具换行与行末空白弱容错；支持新建首版草稿与整章推倒重写；支持将已改动的批注标记为已解决（resolve_annotation）归档；支持草稿版本清单查看与安全删除未定稿草稿。'

  return {
    name: 'manage_drafts',
    label: 'Manage Drafts',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const projectPath = getCurrentProjectPath()
      if (!projectPath) {
        throw new Error(text('未打开小说项目', 'No novel project is currently open'))
      }

      const db = getProjectDb()
      if (!db) {
        throw new Error(text('项目数据库未初始化', 'Project database is not initialized'))
      }

      const chapterNumber = params.chapter_number
      if (!Number.isInteger(chapterNumber) || chapterNumber < 1) {
        throw new Error(text('chapter_number 必须是从 1 开始的正整数', 'chapter_number must be an integer starting at 1'))
      }

      const rawAction = String(params.action || 'read').toLowerCase().trim()

      // =========================================================================
      // 1. 查看版本清单 (list_versions)
      // =========================================================================
      if (rawAction === 'list_versions' || rawAction === '版本清单' || rawAction === '查看版本') {
        const drafts = DraftRepository.listByChapter(chapterNumber)
        if (drafts.length === 0) {
          return {
            content: [{
              type: 'text',
              text: text(
                `第 ${chapterNumber} 章暂无任何草稿记录。可使用 action: "write" 为该章撰写首版草稿。`,
                `Chapter ${chapterNumber} currently has no drafts. Use action: "write" to create the initial draft.`,
              ),
            }],
            details: { chapterNumber, totalVersions: 0, versions: [] },
          }
        }

        const lines: string[] = [
          text(`### 第 ${chapterNumber} 章草稿版本清单（共 ${drafts.length} 版）：\n`, `### Draft Versions for Chapter ${chapterNumber} (${drafts.length} versions):\n`),
        ]

        for (const d of drafts) {
          const statusText = formatDraftStatus(d.status, isEn)
          lines.push(
            `- **Draft v${d.version}** (ID: ${d.id}) · 状态: [${statusText}] · 字数: ${d.wordCount} 字 · 来源: ${d.source} · 更新时间: ${d.updatedAt || d.createdAt}`,
          )
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          details: { chapterNumber, totalVersions: drafts.length, versions: drafts.map(d => ({ id: d.id, version: d.version, status: d.status, wordCount: d.wordCount })) },
        }
      }

      // =========================================================================
      // 2. 查看草稿划词标注列表 (list_annotations)
      // =========================================================================
      if (rawAction === 'list_annotations' || rawAction === '查看标注' || rawAction === '标注列表' || rawAction === '批注') {
        const allDrafts = DraftRepository.listByChapter(chapterNumber)
        if (allDrafts.length === 0) {
          return {
            content: [{
              type: 'text',
              text: text(
                `第 ${chapterNumber} 章暂无任何草稿记录。`,
                `Chapter ${chapterNumber} currently has no drafts.`,
              ),
            }],
            details: { chapterNumber, totalAnnotations: 0, annotations: [] },
          }
        }

        const targetMeta = params.draft_id
          ? DraftRepository.getMeta(params.draft_id)
          : (params.version !== undefined
            ? allDrafts.find(d => d.version === params.version)
            : DraftRepository.getLatestByChapter(chapterNumber))

        if (!targetMeta) {
          throw new Error(text(`未找到第 ${chapterNumber} 章对应的草稿版本`, `Could not find draft for chapter ${chapterNumber}`))
        }

        const annotations = DraftAnnotationRepository.list(targetMeta.id)
        if (annotations.length === 0) {
          return {
            content: [{
              type: 'text',
              text: text(
                `第 ${chapterNumber} 章（Draft v${targetMeta.version}）目前暂无作者划词标注意见。`,
                `Chapter ${chapterNumber} (Draft v${targetMeta.version}) currently has no author annotations.`,
              ),
            }],
            details: { chapterNumber, draftId: targetMeta.id, version: targetMeta.version, totalAnnotations: 0, annotations: [] },
          }
        }

        const lines: string[] = [
          text(
            `### 第 ${chapterNumber} 章作者划词标注清单（Draft v${targetMeta.version} · 共 ${annotations.length} 处修改意见）：\n`,
            `### Author Passage Notes for Chapter ${chapterNumber} (Draft v${targetMeta.version} · ${annotations.length} notes):\n`,
          ),
        ]

        annotations.forEach((item, index) => {
          lines.push(
            text(
              `${index + 1}. 原文选区：「${item.quote.trim()}」\n   作者意见：${item.note.trim()}`,
              `${index + 1}. Original: "${item.quote.trim()}"\n   Author Note: ${item.note.trim()}`,
            ),
          )
        })

        lines.push(
          text(
            `\n（修改提示：可直接调用 action: "replace_excerpt"，将上述「原文选区」作为 old_text，输入修改后的 new_text 完成针对性润色替换）`,
            `\n(Tip: Call action: "replace_excerpt" using the original quote as old_text to apply targeted changes)`,
          ),
        )

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          details: {
            chapterNumber,
            draftId: targetMeta.id,
            version: targetMeta.version,
            totalAnnotations: annotations.length,
            annotations: annotations.map(a => ({ id: a.id, quote: a.quote, note: a.note })),
          },
        }
      }

      // =========================================================================
      // 3. 指定位置局部精准替换 (replace_excerpt - 单处或批量)
      // =========================================================================
      if (rawAction === 'replace_excerpt' || rawAction === '局部替换' || rawAction === '修改段落' || rawAction === '润色') {
        const hasBatch = Array.isArray(params.replacements) && params.replacements.length > 0
        const oldText = params.old_text ?? ''
        const newText = params.new_text ?? ''

        if (!hasBatch && !oldText) {
          throw new Error(text('缺少要替换的原文 old_text 或 replacements 批量列表', 'old_text or replacements list is required for replace_excerpt'))
        }

        if (hasBatch) {
          for (let i = 0; i < params.replacements!.length; i++) {
            const r = params.replacements![i]
            if (!r.old_text || !r.old_text.trim()) {
              throw new Error(text(`第 ${i + 1} 项要替换的原文 old_text 不能为空`, `Item ${i + 1} old_text cannot be empty`))
            }
            if (r.old_text.length > MAX_DRAFT_EXCERPT_CHARS || (r.new_text && r.new_text.length > MAX_DRAFT_EXCERPT_CHARS)) {
              throw new Error(text(
                `第 ${i + 1} 项替换片段过长（单处最多 ${MAX_DRAFT_EXCERPT_CHARS} 字）`,
                `Item ${i + 1} excerpt is too long (max ${MAX_DRAFT_EXCERPT_CHARS} characters)`,
              ))
            }
          }
        } else {
          if (oldText.length > MAX_DRAFT_EXCERPT_CHARS || newText.length > MAX_DRAFT_EXCERPT_CHARS) {
            throw new Error(text(
              `替换片段过长（最多 ${MAX_DRAFT_EXCERPT_CHARS} 字）`,
              `The excerpt is too long (max ${MAX_DRAFT_EXCERPT_CHARS} characters)`,
            ))
          }
        }

        const outcome = await rendererAction({
          type: 'replace_draft_excerpt',
          chapterNumber,
          oldText: hasBatch ? undefined : oldText,
          newText: hasBatch ? undefined : newText,
          replacements: hasBatch ? params.replacements : undefined,
          draftId: params.draft_id,
        })

        if (!outcome || !outcome.ok) {
          const reason = outcome && 'error' in outcome && outcome.error ? outcome.error : text('局部替换失败', 'Failed to replace excerpt')
          throw new Error(reason)
        }

        return {
          content: [{ type: 'text', text: outcome.summary }],
          details: {
            chapterNumber,
            batchCount: hasBatch ? params.replacements!.length : 1,
          },
        }
      }

      // =========================================================================
      // 4. 标记批注已解决 (resolve_annotation)
      // =========================================================================
      if (rawAction === 'resolve_annotation' || rawAction === '解决批注' || rawAction === '解决标注' || rawAction === '归档批注') {
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

        const resolvedCount = params.resolve_all
          ? DraftAnnotationRepository.resolve(targetMeta.id, 'all')
          : (params.annotation_id ? DraftAnnotationRepository.resolve(targetMeta.id, [params.annotation_id]) : 0)

        // 通知渲染进程刷新
        await rendererAction({
          type: 'sync_draft_content',
          chapterNumber,
          draftId: targetMeta.id,
          content: '',
          isNewVersion: false,
        })

        return {
          content: [{
            type: 'text',
            text: text(
              `已成功将第 ${chapterNumber} 章（Draft v${targetMeta.version}）的 ${resolvedCount} 处作者批注标记为已解决并归档。\n下次调用 read 或 list_annotations 时将不再展示已解决项。`,
              `Successfully resolved ${resolvedCount} annotation(s) for chapter ${chapterNumber} (Draft v${targetMeta.version}).`,
            ),
          }],
          details: { chapterNumber, draftId: targetMeta.id, resolvedCount },
        }
      }

      // =========================================================================
      // 3. 删除未定稿草稿 (delete)
      // =========================================================================
      if (rawAction === 'delete' || rawAction === '删除') {
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

        await rendererAction({
          type: 'sync_draft_content',
          chapterNumber,
          draftId,
          content: '',
          isNewVersion: false,
        })

        return {
          content: [{
            type: 'text',
            text: text(
              `已成功删除第 ${chapterNumber} 章的草稿（Draft v${meta.version}, ID: ${draftId}）。`,
              `Deleted draft v${meta.version} (ID: ${draftId}) of chapter ${chapterNumber}.`,
            ),
          }],
          details: { chapterNumber, deletedId: draftId, version: meta.version },
        }
      }

      // =========================================================================
      // 4. 整篇写草稿 / 新建 / 重写 (write)
      // =========================================================================
      if (rawAction === 'write' || rawAction === '新建' || rawAction === '重写' || rawAction === '保存草稿') {
        const content = (params.content || '').trim()
        if (!content) {
          throw new Error(text('写入草稿必须提供非空正文 content', 'content is required for write'))
        }

        const wordCount = countDraftUnits(content)
        const existingDrafts = DraftRepository.listByChapter(chapterNumber)
        const mode = params.mode || (existingDrafts.length > 0 ? 'new_version' : 'new_version')

        // 覆盖模式 (overwrite)
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
          // 全盘覆盖重写时，自动清理旧正文绑定的历史批注，避免悬空残留
          DraftAnnotationRepository.replace(targetMeta.id, [])

          await rendererAction({
            type: 'sync_draft_content',
            chapterNumber,
            draftId: targetMeta.id,
            content,
            isNewVersion: false,
          })

          return {
            content: [{
              type: 'text',
              text: text(
                `已成功全量更新第 ${chapterNumber} 章草稿（Draft v${targetMeta.version}，共 ${wordCount} 字）。正文编辑器与草稿箱已即时同步。`,
                `Successfully updated chapter ${chapterNumber} draft v${targetMeta.version} (${wordCount} words).`,
              ),
            }],
            details: { chapterNumber, draftId: targetMeta.id, version: targetMeta.version, wordCount, mode: 'overwrite' },
          }
        }

        // 新建版本模式 (new_version)
        const source = existingDrafts.length > 0 ? 'rewrite' : 'write'
        const newDraftId = DraftRepository.create({
          chapterNumber,
          source,
          content,
          wordCount,
        })

        const newMeta = DraftRepository.getMeta(newDraftId)
        const newVersion = newMeta?.version ?? (existingDrafts.length + 1)

        await rendererAction({
          type: 'sync_draft_content',
          chapterNumber,
          draftId: newDraftId,
          content,
          isNewVersion: true,
        })

        return {
          content: [{
            type: 'text',
            text: text(
              `已成功为第 ${chapterNumber} 章生成新草稿（Draft v${newVersion}，共 ${wordCount} 字，ID: ${newDraftId}）。\n草稿已入库并在草稿箱中就绪。`,
              `Successfully created new draft v${newVersion} for chapter ${chapterNumber} (${wordCount} words, ID: ${newDraftId}).`,
            ),
          }],
          details: { chapterNumber, draftId: newDraftId, version: newVersion, wordCount, mode: 'new_version' },
        }
      }

      // =========================================================================
      // 5. 读取草稿正文 (read - 默认)
      // =========================================================================
      const allDrafts = DraftRepository.listByChapter(chapterNumber)
      if (allDrafts.length === 0) {
        throw new Error(text(
          `第 ${chapterNumber} 章暂无任何草稿。建议调用 manage_drafts (action: "write") 为该章撰写首版正文。`,
          `No draft found for chapter ${chapterNumber}. Use manage_drafts (action: "write") to create one.`,
        ))
      }

      let targetMeta: ReturnType<typeof DraftRepository.getMeta> | null = null

      if (params.version !== undefined) {
        targetMeta = allDrafts.find(d => d.version === params.version) ?? null
        if (!targetMeta) {
          throw new Error(text(
            `第 ${chapterNumber} 章未找到版本 v${params.version}。当前可用版本：${allDrafts.map(d => `v${d.version}`).join('、')}`,
            `Draft v${params.version} not found for chapter ${chapterNumber}. Available versions: ${allDrafts.map(d => `v${d.version}`).join(', ')}`,
          ))
        }
      } else {
        const rawType = params.draft_type || 'latest'
        if (rawType === 'draft_v1') {
          targetMeta = allDrafts.find(d => d.version === 1) ?? allDrafts[0]
        } else if (rawType === 'revised') {
          targetMeta = allDrafts.find(d => d.status === 'revised' || d.version > 1) ?? allDrafts[allDrafts.length - 1]
        } else {
          targetMeta = DraftRepository.getLatestByChapter(chapterNumber) ?? allDrafts[allDrafts.length - 1]
        }
      }

      if (!targetMeta) {
        throw new Error(text(`未找到第 ${chapterNumber} 章对应的草稿`, `Could not find draft for chapter ${chapterNumber}`))
      }

      const fullDraft = DraftRepository.getFull(targetMeta.id)
      if (!fullDraft) {
        throw new Error(text('读取草稿正文失败，内容表记录缺失', 'Could not read draft content body'))
      }

      const rawBody = fullDraft.content
      const lines = rawBody.split('\n')
      const totalLines = lines.length

      const offset = params.offset ?? 1
      const limit = params.limit ?? 200

      const startIdx = Math.max(0, offset - 1)
      const endIdx = Math.min(totalLines, startIdx + limit)
      const visibleLines = lines.slice(startIdx, endIdx)

      const formatted = visibleLines.map((line, idx) => {
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
        const annotationLines = annotations.map((item, idx) =>
          text(
            `${idx + 1}. 原文选区：「${item.quote.trim()}」\n   作者意见：${item.note.trim()}`,
            `${idx + 1}. Original: "${item.quote.trim()}"\n   Author Note: ${item.note.trim()}`,
          ),
        )
        annotationsSection = text(
          `### 本章作者划词标注（修改意见 · 共 ${annotations.length} 处）：\n${annotationLines.join('\n')}\n（提示：可直接调用 action: "replace_excerpt" 传入上述原文进行定向修改）\n\n---\n\n`,
          `### Author Passage Notes (${annotations.length} notes):\n${annotationLines.join('\n')}\n(Tip: Call action: "replace_excerpt" with the original quote to apply changes)\n\n---\n\n`,
        )
      }

      return {
        content: [{ type: 'text', text: header + annotationsSection + formatted }],
        details: {
          chapterNumber,
          draftId: targetMeta.id,
          version: targetMeta.version,
          status: targetMeta.status,
          wordCount: targetMeta.wordCount,
          totalLines,
          offset: startIdx + 1,
          limit: visibleLines.length,
          annotationsCount: annotations.length,
          annotations: annotations.map(a => ({ id: a.id, quote: a.quote, note: a.note })),
        },
      }
    },
  }
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
