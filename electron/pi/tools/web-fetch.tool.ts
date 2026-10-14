import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import {
  writingLanguageText,
  type WritingLanguage,
} from '../../../src/shared/writing-language'

const DEFAULT_MAX_LENGTH = 50_000
const MAX_ALLOWED_LENGTH = 120_000
const FETCH_TIMEOUT_MS = 15_000

const Schema = Type.Object({
  url: Type.String({
    description: '要读取的完整 HTTP 或 HTTPS 网址。例如 GitHub 仓库页面或代码链接、在线百科条目、参考资料网页、API 文档等。',
  }),
  max_length: Type.Optional(Type.Integer({
    minimum: 500,
    maximum: MAX_ALLOWED_LENGTH,
    description: '返回的最大字符数上限（默认 50000 字符，超长内容自动保留前文并提示截断说明）。',
  })),
})

/**
 * 智能识别 GitHub 网址并优先转换为 raw 内容直链
 */
export function optimizeGithubUrl(rawUrl: string): { fetchUrl: string; isGithubRepoHome: boolean } {
  try {
    const parsed = new URL(rawUrl)
    const hostname = parsed.hostname.toLowerCase()

    if (hostname !== 'github.com') {
      return { fetchUrl: rawUrl, isGithubRepoHome: false }
    }

    const segments = parsed.pathname.split('/').filter(Boolean)
    // 形如 https://github.com/:owner/:repo
    if (segments.length === 2) {
      const [owner, repo] = segments
      // 仓库主页优先直取 README.md
      return {
        fetchUrl: `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.md`,
        isGithubRepoHome: true,
      }
    }

    // 形如 https://github.com/:owner/:repo/blob/:branch/...
    if (segments.length >= 4 && segments[2] === 'blob') {
      const owner = segments[0]
      const repo = segments[1]
      const pathAfterBlob = segments.slice(3).join('/')
      return {
        fetchUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${pathAfterBlob}`,
        isGithubRepoHome: false,
      }
    }

    return { fetchUrl: rawUrl, isGithubRepoHome: false }
  } catch {
    return { fetchUrl: rawUrl, isGithubRepoHome: false }
  }
}

/**
 * 简单安全的 HTML 实体解码与正文转纯文本/轻量 Markdown
 */
export function cleanHtmlToMarkdown(html: string): { title?: string; text: string } {
  let title: string | undefined
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (titleMatch && titleMatch[1]) {
    title = decodeHtmlEntities(titleMatch[1].trim())
  }

  // 1. 剔除噪声标签块 (script, style, svg, noscript, nav, header, footer)
  let clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  // 2. 转换常见排版标签为 Markdown 标记
  clean = clean
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level, content) => {
      const hashes = '#'.repeat(Number(level))
      return `\n\n${hashes} ${content.trim()}\n\n`
    })
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n\n$1\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, ' `$1` ')
    .replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href, textContent) => {
      const trimmedText = textContent.replace(/<[^>]+>/g, '').trim()
      if (!trimmedText) return ''
      return `[${trimmedText}](${href})`
    })

  // 3. 剥离所有残留 HTML 标签
  clean = clean.replace(/<[^>]+>/g, '')

  // 4. 解码 HTML 字符实体
  clean = decodeHtmlEntities(clean)

  // 5. 规范多余空白与换行
  clean = clean
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { title, text: clean }
}

function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
}

function isPrivateIpOrHost(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  if (lower === 'localhost' || lower === '127.0.0.1' || lower === '0.0.0.0' || lower === '::1') {
    return true
  }
  // 简单匹配 10.x, 192.168.x, 172.16-31.x
  if (
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower)
    || /^192\.168\.\d{1,3}\.\d{1,3}$/.test(lower)
    || /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(lower)
  ) {
    return true
  }
  return false
}

export function createWebFetchTool(
  language: WritingLanguage,
): AgentTool<typeof Schema> {
  const text = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)

  const description = language === 'en-US'
    ? 'Fetch the decoded content of a specific HTTP(S) URL. Automatically handles GitHub links (directly reading raw code/README), cleans HTML into readable Markdown text, and applies size truncation.'
    : '抓取并解析指定 HTTP(S) 网页网址的内容。自动针对 GitHub 仓库和文件进行直读优化（直接获取纯净 README 或源码），将网页正文清洗为整洁易读的 Markdown 文本，内置超时与超长截断保护。'

  return {
    name: 'web_fetch',
    label: 'Web Fetch',
    description,
    parameters: Schema,
    execute: async (_id, params) => {
      const rawUrl = (params.url || '').trim()
      if (!rawUrl) {
        throw new Error(text('缺少 url 参数', 'The url parameter is required'))
      }

      let parsedUrl: URL
      try {
        parsedUrl = new URL(rawUrl)
      } catch {
        throw new Error(text(`无效的网址格式：「${rawUrl}」`, `Invalid URL format: "${rawUrl}"`))
      }

      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error(text(
          `仅支持 HTTP 与 HTTPS 协议，已拦截：「${parsedUrl.protocol}」`,
          `Only HTTP and HTTPS protocols are allowed. Blocked: "${parsedUrl.protocol}"`,
        ))
      }

      // 安全防护：拦截指向本机/私网的请求
      if (isPrivateIpOrHost(parsedUrl.hostname)) {
        throw new Error(text(
          `出于安全保护，已拦截对本地或内网地址的访问：「${parsedUrl.hostname}」`,
          `Access to local or private network addresses is blocked: "${parsedUrl.hostname}"`,
        ))
      }

      const maxLength = params.max_length ?? DEFAULT_MAX_LENGTH
      const { fetchUrl, isGithubRepoHome } = optimizeGithubUrl(rawUrl)

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

      try {
        let response = await fetch(fetchUrl, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 (Vela Novel Writer/1.1)',
            'Accept': 'text/html,text/plain,text/markdown,application/json,*/*',
          },
        })

        // 若 GitHub 主页读取 README 发生 404，平滑回退到抓取原始主页
        if (isGithubRepoHome && !response.ok && response.status === 404) {
          response = await fetch(rawUrl, {
            signal: controller.signal,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 (Vela Novel Writer/1.1)',
              'Accept': 'text/html,text/plain,*/*',
            },
          })
        }

        clearTimeout(timer)

        if (!response.ok) {
          throw new Error(text(
            `网页请求失败（HTTP ${response.status} ${response.statusText}）`,
            `Web request failed with HTTP ${response.status} ${response.statusText}`,
          ))
        }

        const contentType = response.headers.get('content-type') || ''
        const rawBody = await response.text()

        let extractedText = ''
        let pageTitle: string | undefined

        if (contentType.includes('text/html')) {
          const cleaned = cleanHtmlToMarkdown(rawBody)
          extractedText = cleaned.text
          pageTitle = cleaned.title
        } else {
          // 纯文本、Markdown 或 JSON，直接保留正文
          extractedText = rawBody.trim()
        }

        if (!extractedText) {
          return {
            content: [{
              type: 'text',
              text: text(
                `已成功连接到网页，但未提取到任何有效可见文本内容。\nURL: ${rawUrl}`,
                `Successfully connected, but no visible text content was found.\nURL: ${rawUrl}`,
              ),
            }],
            details: { url: rawUrl, status: response.status, length: 0 },
          }
        }

        let isTruncated = false
        if (extractedText.length > maxLength) {
          extractedText = extractedText.slice(0, maxLength)
          isTruncated = true
        }

        const lines: string[] = []
        if (pageTitle) {
          lines.push(text(`### 网页标题：${pageTitle}\n`, `### Page Title: ${pageTitle}\n`))
        }
        lines.push(extractedText)

        if (isTruncated) {
          lines.push(text(
            `\n\n> [提示：内容已截断，仅展示前 ${maxLength} 个字符。如需更多细节可指定片段或提高 max_length]`,
            `\n\n> [Notice: Content truncated to the first ${maxLength} characters.]`,
          ))
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          details: {
            url: rawUrl,
            effectiveUrl: fetchUrl,
            status: response.status,
            pageTitle,
            length: extractedText.length,
            truncated: isTruncated,
          },
        }
      } catch (error) {
        clearTimeout(timer)
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(text(
            `访问网页超时（超过 ${FETCH_TIMEOUT_MS / 1000} 秒未响应）：「${rawUrl}」`,
            `Web request timed out (> ${FETCH_TIMEOUT_MS / 1000}s): "${rawUrl}"`,
          ))
        }
        throw error
      }
    },
  }
}
