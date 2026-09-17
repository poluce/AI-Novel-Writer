import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { ProjectCoreRepository } from '../../repositories/project-core-repository'
import type { RendererActionSink } from '../renderer-action'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

const Action = Type.Union([
  Type.Literal('read', { description: 'Read story architecture documents (default)' }),
  Type.Literal('update', { description: 'Update or fill specified story architecture documents' }),
], { description: 'Operation mode: "read" to inspect existing documents, "update" to fill or modify documents' })

const Section = Type.Union([
  Type.Literal('all', { description: 'All three core architecture documents (read-only)' }),
  Type.Literal('premise', { description: 'Story Premise: Logline, core conflict chain, golden finger placement, suspense framework' }),
  Type.Literal('worldbuilding', { description: 'Worldbuilding: core rules, hierarchy and resource battlefields, deep crisis' }),
  Type.Literal('synopsis', { description: 'Whole-book plot outline: overarching story arc, volume outlines, and narrative beats' }),
], { description: 'Architecture section: "premise", "worldbuilding", or "synopsis". Defaults to "all" for read' })

const Schema = Type.Object({
  action: Type.Optional(Action),
  section: Type.Optional(Section),
  content: Type.Optional(Type.String({ description: 'Full-text markdown content to fill into the designated section specified by the "section" parameter' })),
  old_text: Type.Optional(Type.String({ description: 'Targeted snippet replacement: exact original excerpt to replace (for modifying just one paragraph in a long outline or worldbuilding document without rewriting everything)' })),
  new_text: Type.Optional(Type.String({ description: 'Targeted snippet replacement: replacement excerpt' })),
  premise: Type.Optional(Type.String({ description: 'Story premise content: Logline, central conflict chain, protagonist advantage hook, and core suspense' })),
  worldbuilding: Type.Optional(Type.String({ description: 'Worldbuilding content: core setting rules, power/social hierarchy, resource conflicts, and hidden mysteries' })),
  synopsis: Type.Optional(Type.String({ description: 'Plot outline content: whole-novel synopsis, volume-by-volume breakdown, and major story milestones' })),
})

const SECTION_ALIASES: Record<string, 'all' | 'premise' | 'worldbuilding' | 'synopsis'> = {
  all: 'all',
  premise: 'premise',
  worldbuilding: 'worldbuilding',
  synopsis: 'synopsis',
  '全部': 'all',
  '所有': 'all',
  '故事前提': 'premise',
  '前提': 'premise',
  '世界观': 'worldbuilding',
  '设定': 'worldbuilding',
  '情节大纲': 'synopsis',
  '大纲': 'synopsis',
  '核心架构': 'synopsis',
}

const SECTION_LABELS: Record<string, readonly [string, string]> = {
  premise: ['故事前提', 'Story Premise'],
  worldbuilding: ['世界观', 'Worldbuilding'],
  synopsis: ['全书情节大纲', 'Plot Outline'],
}

export function createStoryArchitectureTool(
  language: WritingLanguage,
  rendererAction: RendererActionSink,
): AgentTool<typeof Schema, { action: string; sections?: string[] }> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'Read or update the story architecture documents: story premise (premise), worldbuilding (worldbuilding), and whole-book plot outline (synopsis). Directly fills or modifies designated architecture documents without launching workflows. Use read_characters for character cards.'
    : '读取或修改故事架构三大核心文档：故事前提（premise）、世界观（worldbuilding）、全书情节大纲（synopsis）。与作者讨论确定后，可直接将生成的文档填充到指定架构部分，无需启动工作流。角色资料请用 read_characters。'

  return {
    name: 'story_architecture',
    label: 'Story Architecture',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const core = ProjectCoreRepository.get()
      if (!core) {
        throw new Error(text('项目架构未初始化或未打开项目', 'Project architecture is not initialized or project is not open'))
      }

      const rawAction = String(params.action ?? '').toLowerCase().trim()
      const isExplicitUpdate = rawAction === 'update' || rawAction === '修改' || rawAction === '更新' || rawAction === '填充'
      const isExplicitRead = rawAction === 'read' || rawAction === '读取' || rawAction === '查看'

      const hasUpdatePayload = Boolean(
        params.content
        || params.premise
        || params.worldbuilding
        || params.synopsis
        || (params.old_text && params.new_text),
      )

      const isUpdate = isExplicitUpdate || (!isExplicitRead && hasUpdatePayload)

      if (!isUpdate) {
        // ========== 读取逻辑 ==========
        const rawSection = params.section ?? 'all'
        const requested = SECTION_ALIASES[rawSection] ?? 'all'
        const wanted: Array<'premise' | 'worldbuilding' | 'synopsis'> = requested === 'all'
          ? ['premise', 'worldbuilding', 'synopsis']
          : [requested]

        const blocks: Array<{ key: 'premise' | 'worldbuilding' | 'synopsis'; content: string }> = []
        for (const key of wanted) {
          const content = key === 'premise'
            ? core.premise
            : key === 'worldbuilding'
              ? core.worldbuilding
              : core.synopsis
          if (content && content.trim()) {
            blocks.push({ key, content: content.trim() })
          }
        }

        if (blocks.length === 0) {
          return {
            content: [{
              type: 'text',
              text: requested === 'all'
                ? text(
                    '故事架构为空，暂无故事前提、世界观与情节大纲。可与作者探讨后通过本工具直接填充生成。',
                    'The architecture is empty: no premise, worldbuilding, or plot outline yet. You can discuss with the author and fill them in directly.',
                  )
                : text(
                    `${SECTION_LABELS[requested][0]}尚未填写。`,
                    `${SECTION_LABELS[requested][1]} has not been written yet.`,
                  ),
            }],
            details: { action: 'read', sections: [] },
          }
        }

        const formatted = blocks.map(({ key, content }) => {
          const label = text(SECTION_LABELS[key][0], SECTION_LABELS[key][1])
          return `## ${label}\n\n${content}`
        }).join('\n\n---\n\n')

        return {
          content: [{ type: 'text', text: formatted }],
          details: { action: 'read', sections: blocks.map(b => b.key) },
        }
      }

      // ========== 局部片段精准替换逻辑 ==========
      if (params.old_text && params.new_text) {
        const rawSection = params.section ?? 'synopsis'
        const targetSection = SECTION_ALIASES[rawSection] ?? 'synopsis'
        if (targetSection === 'all') {
          throw new Error(text('局部替换时请指定具体故事架构模块（premise / worldbuilding / synopsis）', 'Please specify a concrete section for targeted replacement'))
        }
        const currentVal = String(core[targetSection] ?? '')
        if (!currentVal.includes(params.old_text)) {
          const sectionName = text(SECTION_LABELS[targetSection][0], SECTION_LABELS[targetSection][1])
          throw new Error(text(
            `在故事架构【${sectionName}】中未找到指定的待替换原文片段。请先读取该模块核对当前原文。`,
            `The specified excerpt was not found in story architecture [${sectionName}]. Please read the document first to verify current text.`,
          ))
        }

        const updatedVal = currentVal.replace(params.old_text, params.new_text)
        ProjectCoreRepository.update({ [targetSection]: updatedVal })
        rendererAction({ type: 'refresh_architecture', section: targetSection })

        const sectionName = text(SECTION_LABELS[targetSection][0], SECTION_LABELS[targetSection][1])
        return {
          content: [{
            type: 'text',
            text: text(
              `已在故事架构【${sectionName}】中成功完成局部段落替换（替换片段：原 ${params.old_text.length} 字 → 新 ${params.new_text.length} 字，其余全篇完整保留未动）。`,
              `Successfully replaced targeted paragraph in story architecture [${sectionName}] (${params.old_text.length} -> ${params.new_text.length} chars, rest of content preserved verbatim).`,
            ),
          }],
          details: { action: 'update', sections: [targetSection] },
        }
      }

      // ========== 整体章节写入 / 填充逻辑 ==========
      const updates: Partial<{ premise: string; worldbuilding: string; synopsis: string }> = {}

      if (params.premise !== undefined) updates.premise = params.premise
      if (params.worldbuilding !== undefined) updates.worldbuilding = params.worldbuilding
      if (params.synopsis !== undefined) updates.synopsis = params.synopsis

      if (params.content !== undefined) {
        const rawSection = params.section ?? 'synopsis'
        const targetSection = SECTION_ALIASES[rawSection]
        if (!targetSection || targetSection === 'all') {
          throw new Error(text(
            '更新故事架构时请指定具体部分（premise / worldbuilding / synopsis）',
            'Please specify a concrete section (premise, worldbuilding, or synopsis) when updating architecture',
          ))
        }
        updates[targetSection] = params.content
      }

      const updatedKeys = Object.keys(updates) as Array<'premise' | 'worldbuilding' | 'synopsis'>
      if (updatedKeys.length === 0) {
        throw new Error(text('未提供需要填充或更新的架构内容', 'No architecture content was provided for update'))
      }

      ProjectCoreRepository.update(updates)

      for (const sectionKey of updatedKeys) {
        rendererAction({ type: 'refresh_architecture', section: sectionKey })
      }

      const summaries = updatedKeys.map(k => {
        const label = text(SECTION_LABELS[k][0], SECTION_LABELS[k][1])
        const prevLen = (core[k] ?? '').trim().length
        const newLen = (updates[k] ?? '').trim().length
        if (prevLen > 0) {
          return text(
            `${label}（修改：原 ${prevLen} 字 → 现 ${newLen} 字）`,
            `${label} (updated: ${prevLen} -> ${newLen} chars)`,
          )
        }
        return text(
          `${label}（新增 ${newLen} 字）`,
          `${label} (added ${newLen} chars)`,
        )
      })

      return {
        content: [{
          type: 'text',
          text: text(
            `已成功保存故事架构：${summaries.join('；')}`,
            `Successfully saved story architecture: ${summaries.join('; ')}`,
          ),
        }],
        details: { action: 'update', sections: updatedKeys },
      }
    },
  }
}
