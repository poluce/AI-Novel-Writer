import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createManageKnowledgeBaseTool } from '../manage-knowledge-base.tool'

const mockState = vi.hoisted(() => ({
  currentProjectPath: null as string | null,
  docs: [
    { id: 'doc-1', fileName: '历史考据.md', chunkCount: 3, importedAt: 1720000000000 },
    { id: 'doc-2', fileName: '世界观架构.md', chunkCount: 5, importedAt: 1720100000000 },
  ],
  stats: {
    documentCount: 2,
    totalChunks: 8,
    vectorDimension: 1536,
  },
}))

vi.mock('../../../services/knowledge-base-loader', () => ({
  knowledgeBaseLoader: {
    run: vi.fn(async (op: (kb: Record<string, unknown>) => unknown) => {
      return op({
        searchKnowledge: vi.fn(async (query: string, _path: string, _proto: string, _model: unknown, _topK: number) => [
          { text: `关于 ${query} 的深度考据资料`, score: 0.92, fileName: '历史考据.md' },
        ]),
        searchKnowledgeFTS: vi.fn(async (query: string, _path: string, _topK: number) => [
          { text: `FTS: ${query}`, score: 0.85, fileName: '历史考据.md' },
        ]),
        listDocuments: vi.fn(async () => [...mockState.docs]),
        importText: vi.fn(async (_text: string, _fileName: string) => ({
          success: true,
          docId: 'new-doc-id',
          chunkCount: 4,
        })),
        removeDocument: vi.fn(async (docId: string) => {
          const idx = mockState.docs.findIndex(d => d.id === docId)
          if (idx >= 0) {
            mockState.docs.splice(idx, 1)
            return true
          }
          return false
        }),
        getKnowledgeStats: vi.fn(async () => ({ ...mockState.stats })),
      })
    }),
  },
}))

vi.mock('../../../database', () => ({
  getCurrentProjectPath: () => mockState.currentProjectPath,
}))

vi.mock('../../../services/embedding-config', () => ({
  getEmbeddingConfig: () => ({
    protocol: 'openai',
    model: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      modelName: 'text-embedding-3-small',
    },
  }),
}))

beforeEach(() => {
  mockState.currentProjectPath = '/workspace/novel-project'
  mockState.docs = [
    { id: 'doc-1', fileName: '历史考据.md', chunkCount: 3, importedAt: 1720000000000 },
    { id: 'doc-2', fileName: '世界观架构.md', chunkCount: 5, importedAt: 1720100000000 },
  ]
})

describe('manage_knowledge_base tool', () => {
  it('rejects when no novel project is open', async () => {
    mockState.currentProjectPath = null
    const tool = createManageKnowledgeBaseTool('zh-CN')

    await expect(tool.execute('call-1', { action: 'list' }))
      .rejects.toThrow('未打开小说项目')
  })

  it('searches knowledge base and formats semantic results', async () => {
    const tool = createManageKnowledgeBaseTool('zh-CN')

    const result = await tool.execute('call-2', {
      action: 'search',
      query: '千禧年互联网',
      top_k: 3,
    })

    const text = result.content[0].type === 'text' ? result.content[0].text : ''
    expect(text).toContain('知识库检索结果（共 1 条）')
    expect(text).toContain('历史考据.md')
    expect(text).toContain('关于 千禧年互联网 的深度考据资料')
  })

  it('auto-defaults to search action when query is provided without action', async () => {
    const tool = createManageKnowledgeBaseTool('zh-CN')

    const result = await tool.execute('call-3', { query: '组织架构' } as never)
    const text = result.content[0].type === 'text' ? result.content[0].text : ''

    expect(text).toContain('知识库检索结果')
    expect(text).toContain('组织架构')
  })

  it('lists all documents stored in project knowledge base', async () => {
    const tool = createManageKnowledgeBaseTool('zh-CN')

    const result = await tool.execute('call-4', { action: 'list' })
    const text = result.content[0].type === 'text' ? result.content[0].text : ''

    expect(text).toContain('项目知识库文档清单（共 2 篇）')
    expect(text).toContain('历史考据.md')
    expect(text).toContain('世界观架构.md')
    expect(text).toContain('ID: `doc-1`')
  })

  it('handles empty document list gracefully', async () => {
    mockState.docs = []
    const tool = createManageKnowledgeBaseTool('zh-CN')

    const result = await tool.execute('call-5', { action: 'list' })
    const text = result.content[0].type === 'text' ? result.content[0].text : ''

    expect(text).toContain('当前知识库为空')
  })

  it('stores text content into knowledge base and appends .md extension if missing', async () => {
    const tool = createManageKnowledgeBaseTool('zh-CN')

    const result = await tool.execute('call-6', {
      action: 'add_text',
      file_name: '魔法等级制度',
      text: '# 魔法体系\n分为见习法师、初级、中级、大魔导师。',
    })

    const text = result.content[0].type === 'text' ? result.content[0].text : ''
    expect(text).toContain('成功将参考文档“魔法等级制度.md”存入项目知识库')
    expect(text).toContain('new-doc-id')
    expect(text).toContain('4 个知识切块')
  })

  it('auto-defaults to add_text when text is provided without explicit action', async () => {
    const tool = createManageKnowledgeBaseTool('zh-CN')

    const result = await tool.execute('call-7', {
      file_name: '科技设定.txt',
      text: '量子通信与超光速引擎设定。',
    } as never)

    const text = result.content[0].type === 'text' ? result.content[0].text : ''
    expect(text).toContain('成功将参考文档“科技设定.txt”存入项目知识库')
  })

  it('deletes a document by doc_id', async () => {
    const tool = createManageKnowledgeBaseTool('zh-CN')

    const result = await tool.execute('call-8', {
      action: 'delete',
      doc_id: 'doc-1',
    })

    const text = result.content[0].type === 'text' ? result.content[0].text : ''
    expect(text).toContain('已成功从知识库中删除文档')
    expect(text).toContain('doc-1')
    expect(mockState.docs.find(d => d.id === 'doc-1')).toBeUndefined()
  })

  it('deletes a document by resolving file_name when doc_id is omitted', async () => {
    const tool = createManageKnowledgeBaseTool('zh-CN')

    const result = await tool.execute('call-9', {
      action: 'delete',
      file_name: '世界观架构.md',
    })

    const text = result.content[0].type === 'text' ? result.content[0].text : ''
    expect(text).toContain('世界观架构.md')
    expect(text).toContain('doc-2')
    expect(mockState.docs.find(d => d.id === 'doc-2')).toBeUndefined()
  })

  it('retrieves knowledge base stats and active vector dimension', async () => {
    const tool = createManageKnowledgeBaseTool('zh-CN')

    const result = await tool.execute('call-10', { action: 'stats' })
    const text = result.content[0].type === 'text' ? result.content[0].text : ''

    expect(text).toContain('项目知识库统计信息')
    expect(text).toContain('文档总数: **2**')
    expect(text).toContain('切块总数: **8**')
    expect(text).toContain('已启用（维度: 1536）')
    expect(text).toContain('text-embedding-3-small')
  })
})
