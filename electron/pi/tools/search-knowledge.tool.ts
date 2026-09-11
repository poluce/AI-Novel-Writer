import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { knowledgeBaseLoader } from '../../services/knowledge-base-loader'
import { getCurrentProjectPath } from '../../database'
import {
  readJsonFile,
  GLOBAL_CONFIG_PATH,
  DEFAULT_GLOBAL_CONFIG,
  MODELS_CONFIG_PATH,
} from '../../utils/config-utils'
import type { GlobalConfig, ModelProfile } from '../../../src/shared/ipc-channels'
import type { EmbeddingOptions } from '../../../src/shared/embedding-options'
import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

const Schema = Type.Object({
  query: Type.String(),
  top_k: Type.Optional(Type.Number()),
})

interface EmbeddingConfig {
  protocol: 'openai' | 'gemini'
  model: { baseUrl: string; apiKey: string; modelName: string; embeddingOptions?: EmbeddingOptions }
}

/** Mirrors kb-controller's private getEmbeddingConfig (reads global + models config). */
function getEmbeddingConfig(): EmbeddingConfig | null {
  const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
  const targetModelId = config.defaultEmbeddingModelId || config.defaultModelId
  if (!targetModelId) return null
  const models = readJsonFile<ModelProfile[]>(MODELS_CONFIG_PATH, [])
  const model = models.find((m) => m.id === targetModelId)
  if (!model) return null
  return {
    protocol: model.protocol as 'openai' | 'gemini',
    model: { baseUrl: model.baseUrl, apiKey: model.apiKey, modelName: model.modelName, embeddingOptions: model.embeddingOptions },
  }
}

export function createSearchKnowledgeTool(
  language: WritingLanguage,
): AgentTool<typeof Schema, { total: number }> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const description = language === 'en-US'
    ? 'Search the knowledge base semantically for reference material, worldbuilding notes, character backgrounds, and story material.'
    : '在知识库中进行语义搜索，查找与查询相关的参考资料、设定文档等。适用于查找世界观设定、角色背景、故事素材等。'

  return {
    name: 'search_knowledge',
    label: 'Search Knowledge',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const query = params.query
      if (!query) {
        throw new Error(text('缺少 query 参数', 'The query argument is required'))
      }
      const topK = params.top_k ?? 5

      const projectPath = getCurrentProjectPath()
      if (!projectPath) {
        throw new Error(text('未打开项目', 'No project is open'))
      }

      const embConfig = getEmbeddingConfig()
      const results = await knowledgeBaseLoader.run((kb) => {
        if (embConfig) {
          return kb.searchKnowledge(query, projectPath, embConfig.protocol, embConfig.model, topK)
        }
        return kb.searchKnowledgeFTS(query, projectPath, topK)
      })

      if (!Array.isArray(results)) {
        throw new Error(text('知识库搜索失败', 'Could not search the knowledge base'))
      }

      if (results.length === 0) {
        return {
          content: [{ type: 'text', text: text(
            '未找到相关结果。请尝试使用不同的关键词搜索，或尝试使用 read_architecture、read_characters 等工具直接读取项目数据。',
            'No relevant results were found. Try different keywords, or use read_architecture or read_characters to read project data directly.',
          ) }],
          details: { total: 0 },
        }
      }

      const formatted = results.map((r, i) => text(
        `### 结果 ${i + 1} (相似度: ${r.score.toFixed(2)})\n来源: ${r.fileName}\n\n${r.text}`,
        `### Result ${i + 1} (similarity: ${r.score.toFixed(2)})\nSource: ${r.fileName}\n\n${r.text}`,
      )).join('\n\n---\n\n')

      return {
        content: [{ type: 'text', text: text(
          `找到 ${results.length} 条相关结果：\n\n${formatted}`,
          `Found ${results.length} relevant results:\n\n${formatted}`,
        ) }],
        details: { total: results.length },
      }
    },
  }
}
