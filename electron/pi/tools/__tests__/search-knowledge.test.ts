import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createSearchKnowledgeTool } from '../search-knowledge.tool'

vi.mock('../../../services/knowledge-base-loader', () => ({
  knowledgeBaseLoader: { run: vi.fn() },
}))
vi.mock('../../../database', () => ({
  getCurrentProjectPath: vi.fn(),
}))
vi.mock('../../../utils/config-utils', () => ({
  readJsonFile: vi.fn(),
  GLOBAL_CONFIG_PATH: '/tmp/global.json',
  DEFAULT_GLOBAL_CONFIG: {},
  MODELS_CONFIG_PATH: '/tmp/models.json',
}))

import { knowledgeBaseLoader } from '../../../services/knowledge-base-loader'
import { getCurrentProjectPath } from '../../../database'
import { readJsonFile } from '../../../utils/config-utils'

const runMock = knowledgeBaseLoader.run as ReturnType<typeof vi.fn>
const projectPathMock = getCurrentProjectPath as ReturnType<typeof vi.fn>
const readJsonMock = readJsonFile as ReturnType<typeof vi.fn>

beforeEach(() => {
  runMock.mockReset()
  projectPathMock.mockReset()
  readJsonMock.mockReset()
})

describe('search_knowledge', () => {
  it('formats semantic search results', async () => {
    projectPathMock.mockReturnValue('/proj')
    readJsonMock.mockImplementation((path: string, def: unknown) => {
      if (path === '/tmp/global.json') return { defaultModelId: 'm1' }
      if (path === '/tmp/models.json') return [{ id: 'm1', protocol: 'gemini', baseUrl: 'x', apiKey: 'k', modelName: 'm' }]
      return def
    })
    runMock.mockImplementation((op: (kb: unknown) => unknown) => op({
      searchKnowledge: async () => [{ text: '设定内容', score: 0.9, fileName: '设定.md' }],
      searchKnowledgeFTS: async () => [],
    }))

    const tool = createSearchKnowledgeTool('zh-CN')
    const result = await tool.execute('c1', { query: '金手指' })
    const first = result.content[0]
    if (first.type === 'text') {
      expect(first.text).toContain('找到 1 条相关结果')
      expect(first.text).toContain('设定内容')
    }
  })

  it('throws when the query is missing', async () => {
    const tool = createSearchKnowledgeTool('zh-CN')
    await expect(tool.execute('c1', { query: '' })).rejects.toThrow('缺少 query 参数')
  })
})
