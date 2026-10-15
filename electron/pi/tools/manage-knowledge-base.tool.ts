import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type, StringEnum } from '@earendil-works/pi-ai'

import { knowledgeBaseLoader } from '../../services/knowledge-base-loader'
import { getCurrentProjectPath } from '../../database'
import { getEmbeddingConfig } from '../../services/embedding-config'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

export const MANAGE_KNOWLEDGE_BASE_ACTIONS = [
  'search',
  'list',
  'add_text',
  'delete',
  'stats',
] as const

export type ManageKnowledgeBaseAction = typeof MANAGE_KNOWLEDGE_BASE_ACTIONS[number]

type LanguageText = (zhCN: string, enUS: string) => string

type ManageKnowledgeBaseParams = {
  action?: ManageKnowledgeBaseAction
  query?: string
  top_k?: number
  file_name?: string
  text?: string
  doc_id?: string
}

type ToolOutput = {
  content: Array<{ type: 'text'; text: string }>
  details: unknown
}

const Schema = Type.Object({
  action: Type.Optional(StringEnum(MANAGE_KNOWLEDGE_BASE_ACTIONS, {
    description: '知识库操作类型：' +
      '"search"（在知识库中进行语义及全文检索，默认）、' +
      '"list"（列出知识库中收录的所有参考文档）、' +
      '"add_text"（将参考资料、史料考据、设定文本直接归档存入知识库）、' +
      '"delete"（从知识库中删除指定的参考文档）、' +
      '"stats"（获取知识库容量及向量状态统计）。',
  })),
  query: Type.Optional(Type.String({
    description: '搜索词或检索问题（search 专用，如 "2000年微软组织架构"）',
  })),
  top_k: Type.Optional(Type.Number({
    description: '搜索返回的最大片段数（默认 5）',
  })),
  file_name: Type.Optional(Type.String({
    description: '文档名称或标题（add_text 必填，如 "千禧年互联网科技史考据.md"；delete 可选作为匹配）',
  })),
  text: Type.Optional(Type.String({
    description: '要存入知识库的参考资料正文或 Markdown 文本（add_text 必填）',
  })),
  doc_id: Type.Optional(Type.String({
    description: '要删除的目标文档 ID（delete 专用）',
  })),
})

function ensureTextFileName(name: string): string {
  const trimmed = name.trim()
  if (trimmed.endsWith('.md') || trimmed.endsWith('.txt')) {
    return trimmed
  }
  return `${trimmed}.md`
}

function extractErrorMessage(result: unknown): string {
  if (result && typeof result === 'object' && 'error' in result && result.error) {
    return String(result.error)
  }
  return 'Unknown error'
}

function formatVectorStatus(dimension: number, text: LanguageText): string {
  if (dimension > 0) {
    return text(`已启用（维度: ${dimension}）`, `Enabled (dimension: ${dimension})`)
  }
  return text('未配置（当前为 BM25 全文检索模式）', 'Not configured (currently in BM25 FTS mode)')
}

function textOutput(body: string, details: unknown): ToolOutput {
  return {
    content: [{ type: 'text', text: body }],
    details,
  }
}

function requireProjectPath(text: LanguageText): string {
  const projectPath = getCurrentProjectPath()
  if (!projectPath) {
    throw new Error(text('未打开小说项目', 'No novel project is open'))
  }
  return projectPath
}

function resolveAction(params: ManageKnowledgeBaseParams): ManageKnowledgeBaseAction {
  if (params.action) return params.action
  if (params.query) return 'search'
  if (params.text || params.file_name) return 'add_text'
  return 'list'
}

async function handleSearch(
  params: ManageKnowledgeBaseParams,
  projectPath: string,
  text: LanguageText,
): Promise<ToolOutput> {
  const query = params.query?.trim()
  if (!query) {
    throw new Error(text('缺少 query 参数（搜索词或问题）', 'The query parameter is required for search'))
  }
  const topK = params.top_k ?? 5

  const embConfig = getEmbeddingConfig()
  const results = await knowledgeBaseLoader.run((kb) => {
    if (embConfig) {
      return kb.searchKnowledge(query, projectPath, embConfig.protocol, embConfig.model, topK)
    }
    return kb.searchKnowledgeFTS(query, projectPath, topK)
  })

  if (!Array.isArray(results)) {
    throw new Error(text('知识库搜索模块暂不可用', 'Knowledge base module is currently unavailable'))
  }

  if (results.length === 0) {
    return textOutput(
      text(
        '知识库中未找到相关内容。可尝试更换搜索词，或使用 action: "list" 查看已收录的参考文档。',
        'No relevant results found in knowledge base. Try different keywords, or use action: "list" to check stored documents.',
      ),
      { total: 0 },
    )
  }

  const formatted = results.map((r, i) => text(
    `### 结果 ${i + 1} (相似度: ${r.score.toFixed(2)})\n**来源**: ${r.fileName}\n\n${r.text}`,
    `### Result ${i + 1} (Score: ${r.score.toFixed(2)})\n**Source**: ${r.fileName}\n\n${r.text}`,
  )).join('\n\n---\n\n')

  return textOutput(
    `${text(`## 知识库检索结果（共 ${results.length} 条）：`, `## Knowledge Base Search Results (${results.length} items):`)}\n\n${formatted}`,
    { total: results.length, results },
  )
}

async function handleList(projectPath: string, text: LanguageText): Promise<ToolOutput> {
  const docs = await knowledgeBaseLoader.run((kb) => kb.listDocuments(projectPath))
  if (!Array.isArray(docs)) {
    throw new Error(text('知识库模块暂不可用', 'Knowledge base module is currently unavailable'))
  }

  if (docs.length === 0) {
    return textOutput(
      text(
        '当前知识库为空，暂未导入任何参考资料。可使用 action: "add_text" 将考据设定保存入库。',
        'Knowledge base is currently empty. Use action: "add_text" to store reference documents.',
      ),
      { total: 0, documents: [] },
    )
  }

  const rows = docs.map((doc, idx) => {
    const dateStr = doc.importedAt ? new Date(doc.importedAt).toLocaleDateString() : ''
    return text(
      `${idx + 1}. **${doc.fileName}** (ID: \`${doc.id}\` · ${doc.chunkCount} 个切块${dateStr ? ` · 导入于 ${dateStr}` : ''})`,
      `${idx + 1}. **${doc.fileName}** (ID: \`${doc.id}\` · ${doc.chunkCount} chunks${dateStr ? ` · ${dateStr}` : ''})`,
    )
  })

  return textOutput(
    `${text(`## 项目知识库文档清单（共 ${docs.length} 篇）：`, `## Knowledge Base Documents (${docs.length} total):`)}\n\n${rows.join('\n')}`,
    { total: docs.length, documents: docs },
  )
}

async function handleAddText(
  params: ManageKnowledgeBaseParams,
  projectPath: string,
  text: LanguageText,
): Promise<ToolOutput> {
  if (!params.file_name?.trim()) {
    throw new Error(text('缺少 file_name 参数（如 "历史考据.md"）', 'The file_name parameter is required'))
  }
  const fileName = ensureTextFileName(params.file_name)

  const rawText = params.text?.trim()
  if (!rawText) {
    throw new Error(text('缺少 text 参数（要存入知识库的文本内容）', 'The text parameter is required'))
  }

  const embConfig = getEmbeddingConfig()
  const result = await knowledgeBaseLoader.run((kb) => {
    return kb.importText(
      rawText,
      fileName,
      projectPath,
      embConfig?.protocol ?? 'openai',
      embConfig?.model ?? { baseUrl: '', apiKey: '', modelName: '' },
    )
  })

  if (!result || typeof result !== 'object' || !('success' in result) || !result.success) {
    const err = extractErrorMessage(result)
    throw new Error(text(`存入知识库失败: ${err}`, `Failed to store into knowledge base: ${err}`))
  }

  return textOutput(
    text(
      `成功将参考文档“${fileName}”存入项目知识库（切分为 ${result.chunkCount ?? 0} 个知识切块，文档 ID: \`${result.docId}\`）。后续可通过语义检索随时调取。`,
      `Successfully stored document "${fileName}" into knowledge base (${result.chunkCount ?? 0} chunks, Doc ID: \`${result.docId}\`).`,
    ),
    { fileName, docId: result.docId, chunkCount: result.chunkCount },
  )
}

async function handleDelete(
  params: ManageKnowledgeBaseParams,
  projectPath: string,
  text: LanguageText,
): Promise<ToolOutput> {
  let targetDocId = params.doc_id?.trim()
  let targetFileName = params.file_name?.trim()

  if (!targetDocId && targetFileName) {
    const fileName = targetFileName
    const docs = await knowledgeBaseLoader.run((kb) => kb.listDocuments(projectPath))
    if (Array.isArray(docs)) {
      const matched = docs.find((d) => d.fileName === fileName || d.fileName.startsWith(fileName))
      if (matched) {
        targetDocId = matched.id
        targetFileName = matched.fileName
      }
    }
  }

  if (!targetDocId) {
    throw new Error(text(
      '缺少 doc_id 或有效的 file_name 参数（无法确定要删除的文档）',
      'The doc_id or valid file_name parameter is required to delete a document',
    ))
  }

  const removeRes = await knowledgeBaseLoader.run((kb) => kb.removeDocument(targetDocId, projectPath))
  if (removeRes !== true) {
    throw new Error(text(`删除文档失败（Doc ID: ${targetDocId}）`, `Failed to delete document (Doc ID: ${targetDocId})`))
  }

  return textOutput(
    text(
      `已成功从知识库中删除文档（${targetFileName ? `“${targetFileName}”，` : ''}ID: \`${targetDocId}\`）。`,
      `Successfully deleted document from knowledge base (${targetFileName ? `"${targetFileName}", ` : ''}ID: \`${targetDocId}\`).`,
    ),
    { docId: targetDocId, fileName: targetFileName },
  )
}

async function handleStats(projectPath: string, text: LanguageText): Promise<ToolOutput> {
  const stats = await knowledgeBaseLoader.run((kb) => kb.getKnowledgeStats(projectPath))
  if (!stats || typeof stats !== 'object' || !('documentCount' in stats)) {
    throw new Error(text('无法获取知识库统计信息', 'Failed to retrieve knowledge base stats'))
  }

  const embConfig = getEmbeddingConfig()
  const vectorStatus = formatVectorStatus(stats.vectorDimension, text)
  const embeddingLine = embConfig
    ? `- ${text('当前嵌入模型', 'Embedding model')}: \`${embConfig.model.modelName}\` (${embConfig.protocol})\n`
    : ''

  return textOutput(
    `${text('## 项目知识库统计信息：', '## Knowledge Base Statistics:')}\n` +
      `- ${text('文档总数', 'Document count')}: **${stats.documentCount}**\n` +
      `- ${text('切块总数', 'Total chunks')}: **${stats.totalChunks}**\n` +
      `- ${text('向量检索状态', 'Vector status')}: ${vectorStatus}\n` +
      embeddingLine,
    { stats, embConfig: embConfig ? { protocol: embConfig.protocol, model: embConfig.model.modelName } : null },
  )
}

/** 判定某次 manage_knowledge_base 调用是否为写入操作。 */
export function isManageKnowledgeBaseWrite(params: Record<string, unknown>): boolean {
  const rawAction = String(params.action ?? '').toLowerCase().trim()
  if (rawAction === 'add_text' || rawAction === 'delete' || rawAction === '添加' || rawAction === '删除') {
    return true
  }
  if (
    rawAction === 'search'
    || rawAction === 'list'
    || rawAction === 'stats'
    || rawAction === '搜索'
    || rawAction === '检索'
    || rawAction === '列表'
    || rawAction === '统计'
  ) {
    return false
  }
  // 未指定 action 时的推断：传了 text 或 file_name 为写入归档
  if (params.text || params.file_name) return true
  return false
}

/**
 * 统一知识库管理工具（Manage Knowledge Base）：
 *
 * 集合了知识库的全生命周期操作：
 * - 检索（search）：混合语义近邻与 BM25 全文检索；
 * - 目录（list）：列出已导入的参考文档列表；
 * - 归档（add_text）：将对话搜集到的资料或设定直接沉淀进知识库；
 * - 删除（delete）：清理过期或冗余的参考资料；
 * - 统计（stats）：查询文档数、切块数与向量维度。
 *
 * 只读操作（search, list, stats）自动放行；
 * 变更操作（add_text, delete）受受控 Seam 保护。
 */
export function createManageKnowledgeBaseTool(
  language: WritingLanguage,
): AgentTool<typeof Schema, unknown> {
  function text(zhCN: string, enUS: string): string {
    return writingLanguageText(language, zhCN, enUS)
  }

  return {
    name: 'manage_knowledge_base',
    label: 'Manage Knowledge Base',
    description: text(
      '统一知识库管理与检索工具：在知识库中进行语义/全文混合检索（search）、列出已收录参考文档（list）、将参考资料或考据设定保存入库（add_text）、删除过时文档（delete）、查看知识库统计（stats）。',
      'Unified knowledge base management and search: search reference materials using semantic/FTS retrieval (search), list installed documents (list), store reference or worldbuilding text into knowledge base (add_text), delete obsolete document (delete), inspect knowledge base stats (stats).',
    ),
    parameters: Schema,
    isWriteOperation: isManageKnowledgeBaseWrite,
    execute: async (_id, params) => {
      const projectPath = requireProjectPath(text)
      const action = resolveAction(params)

      switch (action) {
        case 'search':
          return handleSearch(params, projectPath, text)
        case 'list':
          return handleList(projectPath, text)
        case 'add_text':
          return handleAddText(params, projectPath, text)
        case 'delete':
          return handleDelete(params, projectPath, text)
        case 'stats':
          return handleStats(projectPath, text)
        default:
          throw new Error(text(`不支持的操作类型: ${action}`, `Unsupported action: ${action}`))
      }
    },
  }
}
