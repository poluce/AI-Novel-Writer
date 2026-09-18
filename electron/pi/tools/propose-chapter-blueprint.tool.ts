import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { BlueprintRepository } from '../../repositories/blueprint-repository'
import {
  buildChapterBlueprintProposal,
  defaultEmptyBlueprint,
} from '../../../src/shared/domain-proposals'
import type { BlueprintData } from '../../../src/shared/blueprint'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

const Action = Type.Union([
  Type.Literal('read', { description: '读取章节细纲（未指定章节号则返回全部或指定范围的完整蓝图文档）' }),
  Type.Literal('create', { description: '为指定章节创建全新细纲蓝图' }),
  Type.Literal('update', { description: '修改指定章节蓝图的部分或全部字段' }),
  Type.Literal('upsert', { description: '智能写入：若已存在则更新，若不存在则创建（默认）' }),
  Type.Literal('delete', { description: '删除指定章节蓝图' }),
], { description: '操作类型：默认为 upsert 智能写入' })

const BlueprintItemSchema = Type.Object({
  chapter_number: Type.Number({ description: '目标章节号（正整数，如 1）' }),
  title: Type.Optional(Type.String({ description: '章节标题' })),
  role: Type.Optional(Type.String({ description: '章节在全书或分卷中的作用（如：开端、发展、铺垫、转折、高潮、收尾）' })),
  purpose: Type.Optional(Type.String({ description: '本章核心目标与剧情推进动力' })),
  key_events: Type.Optional(Type.String({ description: '本章关键情节节拍与核心事件链' })),
  characters: Type.Optional(Type.Union([
    Type.Array(Type.String(), { description: '本章出场角色名单' }),
    Type.String({ description: '角色名单（支持逗号或顿号分隔）' }),
  ])),
  suspense_hook: Type.Optional(Type.String({ description: '章末悬念钩子、未解之谜或下章引子' })),
  user_guidance: Type.Optional(Type.String({ description: '作者给本章的创作要求或特殊指导' })),
  notes: Type.Optional(Type.String({ description: '本章伏笔备忘与重要提示' })),
  changes: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: '要修改或填充的字段字典' })),
  old_text: Type.Optional(Type.String({ description: '局部替换：待替换的原文本段落（如修改 key_events 中的某一段）' })),
  new_text: Type.Optional(Type.String({ description: '局部替换：替换后的新文本段落' })),
})

const Schema = Type.Object({
  action: Type.Optional(Action),
  chapter_number: Type.Optional(Type.Number({ description: '目标章节号（正整数，如 1）。若批量操作则可省略，或在 blueprints 中指定。' })),
  start_chapter: Type.Optional(Type.Number({ description: '起始章节号（范围读取时指定）' })),
  end_chapter: Type.Optional(Type.Number({ description: '结束章节号（范围读取时指定）' })),
  title: Type.Optional(Type.String({ description: '章节标题' })),
  role: Type.Optional(Type.String({ description: '章节作用（如：开端、铺垫、发展、转折、高潮、收尾）' })),
  purpose: Type.Optional(Type.String({ description: '本章核心目标与推进目的' })),
  key_events: Type.Optional(Type.String({ description: '本章关键事件与剧情节拍' })),
  characters: Type.Optional(Type.Union([
    Type.Array(Type.String(), { description: '出场角色列表' }),
    Type.String({ description: '出场角色（逗号分隔）' }),
  ])),
  suspense_hook: Type.Optional(Type.String({ description: '章末悬念钩子' })),
  user_guidance: Type.Optional(Type.String({ description: '作者指导' })),
  notes: Type.Optional(Type.String({ description: '备忘与伏笔提示' })),
  field: Type.Optional(Type.String({ description: '指定要操作的单字段名称' })),
  content: Type.Optional(Type.String({ description: '指定单字段时的文本内容' })),
  changes: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: '批量字段变更字典' })),
  old_text: Type.Optional(Type.String({ description: '局部段落替换：原文本' })),
  new_text: Type.Optional(Type.String({ description: '局部段落替换：新文本' })),
  blueprints: Type.Optional(Type.Array(BlueprintItemSchema, { description: '批量多章提交：一次性创建或更新多个章节的蓝图列表' })),
})

export function createProposeChapterBlueprintTool(
  language: WritingLanguage,
): AgentTool<typeof Schema, { chapterNumber?: number; fields?: number; totalCount?: number; isNew?: boolean; status?: string }> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'Comprehensive chapter blueprint tool: supports reading, creating, partial updating, full rewriting, and batch creation of chapter blueprints for any chapter.'
    : '章节蓝图全功能工具：支持任意章节蓝图的读取、全新创建、局部字段微调、段落局部替换（old_text/new_text）、整章全量覆写以及批量多章蓝图一次性创建。'

  return {
    name: 'propose_chapter_blueprint',
    label: 'Chapter Blueprint',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const action = params.action || 'upsert'

      // ==========================================
      // 1. 删除分支 (action: 'delete')
      // ==========================================
      if (action === 'delete') {
        const chapterNumber = params.chapter_number
        if (!chapterNumber || chapterNumber <= 0) {
          return {
            content: [{ type: 'text', text: text('删除失败：必须指定要删除的章节号 chapter_number。', 'Delete failed: chapter_number is required.') }],
            details: { status: 'failed' },
          }
        }
        BlueprintRepository.delete(chapterNumber)
        return {
          content: [{ type: 'text', text: text(`第 ${chapterNumber} 章蓝图已成功删除。`, `Chapter ${chapterNumber} blueprint deleted successfully.`) }],
          details: { chapterNumber, status: 'deleted' },
        }
      }

      // ==========================================
      // 2. 读取分支 (action: 'read')
      // ==========================================
      if (action === 'read') {
        const chapterNumber = params.chapter_number
        const startChapter = params.start_chapter
        const endChapter = params.end_chapter

        // 2.1 未指定具体章节：导出全书或指定范围的完整细纲文档
        if (!chapterNumber || chapterNumber <= 0) {
          let all = BlueprintRepository.getAll()
          if (startChapter || endChapter) {
            const start = Math.max(1, startChapter || 1)
            const end = Math.max(start, endChapter || 9999)
            all = all.filter(bp => bp.chapterNumber >= start && bp.chapterNumber <= end)
          }

          if (all.length === 0) {
            return {
              content: [{ type: 'text', text: text(
                '当前项目尚未找到匹配的章节蓝图。你可以直接使用此工具创建第 1 章或批量创建前几章细纲。',
                'No matching chapter blueprints exist yet in this project. You can create them with this tool.',
              ) }],
              details: { totalCount: 0 },
            }
          }

          const doc = all.map(bp => (
            `### 第 ${bp.chapterNumber} 章：${bp.title || '（未定标题）'} [${bp.role || '未定'}]\n`
            + `- 核心目的：${bp.purpose || '（未定）'}\n`
            + `- 关键事件：\n${bp.keyEvents || '（未定）'}\n`
            + `- 出场角色：${bp.characters && bp.characters.length > 0 ? bp.characters.join('、') : '无'}\n`
            + `- 悬念钩子：${bp.suspenseHook || '无'}\n`
            + (bp.userGuidance ? `- 微操指引：${bp.userGuidance}\n` : '')
            + (bp.notes ? `- 备忘提示：${bp.notes}\n` : '')
          )).join('\n\n---\n\n')

          return {
            content: [{ type: 'text', text: text(
              `# 章节蓝图细纲文档（共 ${all.length} 章）\n\n${doc}`,
              `# Chapter Blueprints Document (${all.length} chapters)\n\n${doc}`,
            ) }],
            details: { totalCount: all.length },
          }
        }

        // 2.2 读取单章详情
        const bp = BlueprintRepository.getByChapter(chapterNumber)
        if (!bp) {
          return {
            content: [{ type: 'text', text: text(
              `第 ${chapterNumber} 章蓝图目前尚未创建。你可以直接传入 title, purpose, key_events 等字段为该章创建蓝图。`,
              `Chapter ${chapterNumber} blueprint has not been created yet. You can create it by providing title, purpose, key_events, etc.`,
            ) }],
            details: { chapterNumber },
          }
        }

        return {
          content: [{ type: 'text', text: text(
            `第 ${chapterNumber} 章蓝图\n\n标题: ${bp.title || '（未定）'}\n作用: ${bp.role}\n目的: ${bp.purpose || '（未定）'}\n关键事件: ${bp.keyEvents || '（未定）'}\n出场角色: ${bp.characters && bp.characters.length > 0 ? bp.characters.join('、') : '无'}\n悬念钩子: ${bp.suspenseHook || '无'}\n备注: ${bp.notes || '无'}\n用户指引: ${bp.userGuidance || '无'}`,
            `Chapter ${chapterNumber} blueprint\n\nTitle: ${bp.title}\nRole: ${bp.role}\nPurpose: ${bp.purpose}\nKey events: ${bp.keyEvents}\nCharacters: ${bp.characters ? bp.characters.join(', ') : ''}\nSuspense hook: ${bp.suspenseHook}\nNotes: ${bp.notes}\nUser guidance: ${bp.userGuidance}`,
          ) }],
          details: { chapterNumber },
        }
      }

      // ==========================================
      // 2. 批量多章创建/更新 (params.blueprints)
      // ==========================================
      if (Array.isArray(params.blueprints) && params.blueprints.length > 0) {
        const results: string[] = []
        let successCount = 0

        for (const item of params.blueprints) {
          const chNum = item.chapter_number
          if (!Number.isInteger(chNum) || chNum <= 0) {
            results.push(`章节号 ${chNum} 无效，已跳过`)
            continue
          }
          const current = BlueprintRepository.getByChapter(chNum)
          const isNew = !current
          const base: BlueprintData = current ?? defaultEmptyBlueprint(chNum)

          const proposal = buildChapterBlueprintProposal(
            item as Record<string, unknown>,
            current,
            text,
          )

          if (!proposal.valid) {
            results.push(`第 ${chNum} 章失败：${proposal.error}`)
            continue
          }

          const merged: BlueprintData = {
            ...base,
            ...proposal.changes,
          }

          BlueprintRepository.upsert(merged)
          successCount++
          results.push(`第 ${chNum} 章 [${merged.title || '无标题'}] ${isNew ? '新建成功' : '更新成功'}`)
        }

        return {
          content: [{ type: 'text', text: text(
            `批量蓝图操作完成（成功 ${successCount}/${params.blueprints.length} 章）：\n\n${results.join('\n')}`,
            `Batch blueprints operation complete (${successCount}/${params.blueprints.length} succeeded):\n\n${results.join('\n')}`,
          ) }],
          details: { totalCount: successCount },
        }
      }

      // ==========================================
      // 3. 单章创建 / 更新 / 局部替换 (单章模式)
      // ==========================================
      const chapterNumber = params.chapter_number
      if (!Number.isInteger(chapterNumber) || (chapterNumber as number) <= 0) {
        return {
          content: [{ type: 'text', text: text(
            '蓝图操作未通过：必须提供有效的正整数 chapter_number（例如 1），或者在 blueprints 数组中批量提供。',
            'Operation failed: A valid positive integer chapter_number (e.g. 1) is required.',
          ) }],
          details: { status: 'failed' },
        }
      }

      const current = BlueprintRepository.getByChapter(chapterNumber as number)
      const isNew = !current
      const base: BlueprintData = current ?? defaultEmptyBlueprint(chapterNumber as number)

      const proposal = buildChapterBlueprintProposal(
        params as Record<string, unknown>,
        current,
        text,
      )

      if (!proposal.valid) {
        return {
          content: [{ type: 'text', text: text(
            `第 ${chapterNumber} 章蓝图参数校验未通过：${proposal.error}。请核实后重试。`,
            `Chapter ${chapterNumber} blueprint validation failed: ${proposal.error}. Please adjust parameters and try again.`,
          ) }],
          details: { chapterNumber, error: proposal.error, status: 'failed' },
        }
      }

      const changes = proposal.changes as Partial<BlueprintData>
      const updated: BlueprintData = {
        ...base,
        ...changes,
      }

      BlueprintRepository.upsert(updated)

      const fieldList = Object.keys(changes).join(', ')
      const summaryText = text(
        `第 ${chapterNumber} 章蓝图${isNew ? '已成功创建' : '已成功更新'}！\n\n`
        + `标题: ${updated.title || '（未定）'}\n`
        + `作用: ${updated.role}\n`
        + `目的: ${updated.purpose || '（未定）'}\n`
        + `关键事件: ${updated.keyEvents || '（未定）'}\n`
        + `出场角色: ${updated.characters && updated.characters.length > 0 ? updated.characters.join(', ') : '无'}\n`
        + `悬念钩子: ${updated.suspenseHook || '无'}\n`
        + `变更字段: ${fieldList}`,
        `Chapter ${chapterNumber} blueprint ${isNew ? 'created' : 'updated'} successfully!\n\n`
        + `Title: ${updated.title}\nRole: ${updated.role}\nPurpose: ${updated.purpose}\nKey events: ${updated.keyEvents}\n`
        + `Characters: ${updated.characters.join(', ')}\nHook: ${updated.suspenseHook}\nChanged fields: ${fieldList}`,
      )

      return {
        content: [{ type: 'text', text: summaryText }],
        details: { chapterNumber, isNew, fields: Object.keys(changes).length },
      }
    },
  }
}
