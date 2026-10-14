import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createWebFetchTool,
  optimizeGithubUrl,
  cleanHtmlToMarkdown,
} from '../web-fetch.tool'

describe('optimizeGithubUrl', () => {
  it('leaves non-github URLs untouched', () => {
    expect(optimizeGithubUrl('https://example.com/page.html')).toEqual({
      fetchUrl: 'https://example.com/page.html',
      isGithubRepoHome: false,
    })
  })

  it('converts GitHub repo home URL to raw README.md link', () => {
    expect(optimizeGithubUrl('https://github.com/poluce/AI-Novel-Writer')).toEqual({
      fetchUrl: 'https://raw.githubusercontent.com/poluce/AI-Novel-Writer/HEAD/README.md',
      isGithubRepoHome: true,
    })
  })

  it('converts GitHub blob file URL to raw githubusercontent link', () => {
    expect(optimizeGithubUrl('https://github.com/poluce/AI-Novel-Writer/blob/main/docs/arch.md')).toEqual({
      fetchUrl: 'https://raw.githubusercontent.com/poluce/AI-Novel-Writer/main/docs/arch.md',
      isGithubRepoHome: false,
    })
  })
})

describe('cleanHtmlToMarkdown', () => {
  it('strips scripts, styles, svgs and extracts title and formatted content', () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>测试文档 &amp; 设定指南</title>
          <style>body { font-size: 16px; }</style>
          <script>alert(1);</script>
        </head>
        <body>
          <header><nav><a href="/home">首页</a></nav></header>
          <h1>主要设定</h1>
          <p>这是<strong>正文</strong>第一段。<br/>包含换行。</p>
          <ul>
            <li>境界一：练气</li>
            <li>境界二：筑基</li>
          </ul>
          <a href="https://example.com/details">详细传送门</a>
          <footer>&copy; 2026 版权所有</footer>
        </body>
      </html>
    `
    const { title, text } = cleanHtmlToMarkdown(html)
    expect(title).toBe('测试文档 & 设定指南')
    expect(text).toContain('# 主要设定')
    expect(text).toContain('这是正文第一段。\n包含换行。')
    expect(text).toContain('- 境界一：练气')
    expect(text).toContain('- 境界二：筑基')
    expect(text).toContain('[详细传送门](https://example.com/details)')
    expect(text).not.toContain('alert(1)')
    expect(text).not.toContain('font-size')
    expect(text).not.toContain('版权所有')
  })
})

describe('web_fetch tool execution', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('rejects invalid or non-HTTP protocols', async () => {
    const tool = createWebFetchTool('zh-CN')
    await expect(tool.execute('c1', { url: 'file:///etc/passwd' })).rejects.toThrow('仅支持 HTTP 与 HTTPS 协议')
    await expect(tool.execute('c2', { url: 'ftp://ftp.example.com' })).rejects.toThrow('仅支持 HTTP 与 HTTPS 协议')
    await expect(tool.execute('c3', { url: '' })).rejects.toThrow('缺少 url 参数')
  })

  it('blocks private or localhost network addresses', async () => {
    const tool = createWebFetchTool('zh-CN')
    await expect(tool.execute('c4', { url: 'http://localhost:3000/api' })).rejects.toThrow('出于安全保护，已拦截')
    await expect(tool.execute('c5', { url: 'http://127.0.0.1:8080/data' })).rejects.toThrow('出于安全保护，已拦截')
    await expect(tool.execute('c6', { url: 'http://192.168.1.10/admin' })).rejects.toThrow('出于安全保护，已拦截')
  })

  it('successfully fetches and cleans HTML web page', async () => {
    const mockHtml = `
      <html>
        <head><title>修真世界观说明</title></head>
        <body>
          <h2>境界体系</h2>
          <p>练气、筑基、金丹、元婴。</p>
        </body>
      </html>
    `
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      text: async () => mockHtml,
    })

    const tool = createWebFetchTool('zh-CN')
    const result = await tool.execute('c7', { url: 'https://novel-wiki.org/cultivation' })

    const first = result.content[0]
    expect(first.type).toBe('text')
    if (first.type === 'text') {
      expect(first.text).toContain('网页标题：修真世界观说明')
      expect(first.text).toContain('## 境界体系')
      expect(first.text).toContain('练气、筑基、金丹、元婴。')
    }
    expect(result.details.pageTitle).toBe('修真世界观说明')
  })

  it('fetches plain text directly without stripping tags', async () => {
    const plainProse = '### 纯文本大纲\n1. 遇敌\n2. 激战'
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/plain; charset=utf-8' }),
      text: async () => plainProse,
    })

    const tool = createWebFetchTool('zh-CN')
    const result = await tool.execute('c8', { url: 'https://raw.githubusercontent.com/user/repo/main/outline.txt' })

    const first = result.content[0]
    if (first.type === 'text') {
      expect(first.text).toBe(plainProse)
    }
  })

  it('optimizes GitHub repo link to fetch raw README first', async () => {
    const mockReadme = '# AI Novel Writer\nProject description and architecture.'
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => mockReadme,
    })

    const tool = createWebFetchTool('zh-CN')
    const result = await tool.execute('c9', { url: 'https://github.com/poluce/AI-Novel-Writer' })

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/poluce/AI-Novel-Writer/HEAD/README.md',
      expect.any(Object),
    )
    const first = result.content[0]
    if (first.type === 'text') {
      expect(first.text).toContain('AI Novel Writer')
    }
  })

  it('falls back to repository page if GitHub README returns 404', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html><title>poluce/repo</title><body>Repository without readme</body></html>',
      })

    const tool = createWebFetchTool('zh-CN')
    const result = await tool.execute('c10', { url: 'https://github.com/poluce/repo' })

    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
    const first = result.content[0]
    if (first.type === 'text') {
      expect(first.text).toContain('Repository without readme')
    }
  })

  it('truncates content when exceeding max_length', async () => {
    const longText = 'A'.repeat(2000)
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => longText,
    })

    const tool = createWebFetchTool('zh-CN')
    const result = await tool.execute('c11', {
      url: 'https://example.com/long.txt',
      max_length: 500,
    })

    expect(result.details.truncated).toBe(true)
    const first = result.content[0]
    if (first.type === 'text') {
      expect(first.text).toContain('内容已截断')
      expect(first.text.length).toBeLessThan(1000)
    }
  })

  it('reports friendly error on HTTP failures', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    })

    const tool = createWebFetchTool('zh-CN')
    await expect(tool.execute('c12', { url: 'https://example.com/missing' }))
      .rejects.toThrow('网页请求失败（HTTP 404 Not Found）')
  })
})
