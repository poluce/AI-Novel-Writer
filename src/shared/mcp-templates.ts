export interface MCPTemplate {
  id: string
  name: string
  nameEn: string
  category: 'search' | 'fetch' | 'filesystem'
  description: string
  descriptionEn: string
  transport: 'stdio' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
}

export const MCP_TEMPLATES: readonly MCPTemplate[] = [
  {
    id: 'anysearch',
    name: 'AnySearch 全网检索',
    nameEn: 'AnySearch Web Search',
    category: 'search',
    description: '专为 AI Agent 设计的实时全网多源检索与正文深度提取，原生支持垂直领域。',
    descriptionEn: 'Real-time multi-source web search and full-text extraction designed for AI agents.',
    transport: 'sse',
    url: 'https://api.anysearch.com/mcp',
  },
  {
    id: 'fetch',
    name: '官方 Fetch 网页提取',
    nameEn: 'Official Fetch Service',
    category: 'fetch',
    description: 'Anthropic 官方网页抓取服务，将任意公开 URL 网页转换为整洁 Markdown。',
    descriptionEn: 'Official web content fetcher, converting web pages into clean Markdown.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
  },
  {
    id: 'brave-search',
    name: 'Brave 商业搜索',
    nameEn: 'Brave Search',
    category: 'search',
    description: '基于 Brave API 的全球隐私网络搜索，需在环境变量中填入 Brave API Key。',
    descriptionEn: 'Global web search via Brave Search API. Requires BRAVE_API_KEY in environment.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: { BRAVE_API_KEY: 'YOUR_BRAVE_API_KEY' },
  },
  {
    id: 'filesystem',
    name: '本地参考书库访问',
    nameEn: 'Local Filesystem Access',
    category: 'filesystem',
    description: 'Anthropic 官方文件系统服务，允许助手访问指定的本地参考书库或设定文件夹。',
    descriptionEn: 'Official filesystem server to let the assistant inspect specified local reference folders.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\path\\to\\allowed\\folder'],
  },
] as const
