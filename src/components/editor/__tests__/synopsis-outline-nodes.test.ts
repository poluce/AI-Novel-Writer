import { describe, expect, it } from 'vitest'

import {
  matchChapterLabel,
  maxCoveredChapter,
  parseChapterNumber,
  parseSynopsis,
  replaceSynopsisNodeBody,
  synopsisNodeBody,
} from '../synopsis-outline-nodes'

const MARKER = '> 本大纲已覆盖至第 20 章（全书 100 章），其余章节将在后续批次继续生成。'

const outline = [
  '# 情节大纲',
  '',
  '全书围绕灵脉异变展开，主角从铁砧镇一路追查到终局。',
  '',
  '## 第一卷',
  '',
  '第1–20章：核对记录',
  '林舟逐条核对旧案记录，确认灵脉异变的第一个信号。',
  '',
  '第21章：破门',
  '宗门废墟之下，林舟第一次触碰旧铁锤里的传承。',
  '',
  '## 第二卷',
  '',
  '第22–100章：反噬',
  '记忆损耗的代价持续推进，并在终局兑现。',
  '',
  MARKER,
  '',
].join('\n')

describe('parseChapterNumber', () => {
  it('reads Arabic and Chinese numerals', () => {
    expect(parseChapterNumber('21')).toBe(21)
    expect(parseChapterNumber('十二')).toBe(12)
    expect(parseChapterNumber('二十一')).toBe(21)
    expect(parseChapterNumber('一百零三')).toBe(103)
    expect(parseChapterNumber('零')).toBeNull()
    expect(parseChapterNumber('abc')).toBeNull()
  })
})

describe('matchChapterLabel', () => {
  it('recognizes the chapter-range shapes the outline prompt produces', () => {
    expect(matchChapterLabel('第1–20章：核对记录')).toEqual({ from: 1, to: 20, title: '核对记录' })
    expect(matchChapterLabel('第21章：破门')).toEqual({ from: 21, to: 21, title: '破门' })
    expect(matchChapterLabel('第一章：旧铁锤')).toEqual({ from: 1, to: 1, title: '旧铁锤' })
    expect(matchChapterLabel('第 3 章 至 第 5 章：过渡')).toEqual({ from: 3, to: 5, title: '过渡' })
    expect(matchChapterLabel('## 第7章 收束')).toEqual({ from: 7, to: 7, title: '收束' })
    expect(matchChapterLabel('- **第8–12章：合流**')).toEqual({ from: 8, to: 12, title: '合流' })
    expect(matchChapterLabel('第21-40章 双线并行')).toEqual({ from: 21, to: 40, title: '双线并行' })
  })

  it('ignores batch markers and ordinary prose', () => {
    expect(matchChapterLabel(MARKER)).toBeNull()
    expect(matchChapterLabel('第3章里主角发现了真相，但他没有声张。')).toBeNull()
    expect(matchChapterLabel('')).toBeNull()
  })
})

describe('parseSynopsis', () => {
  it('splits the outline into chapter-range nodes and keeps the marker out of the bodies', () => {
    const parsed = parseSynopsis(outline)

    expect(parsed.title).toBe('情节大纲')
    expect(parsed.hasChapterLabels).toBe(true)
    expect(parsed.markerStart).toBe(outline.indexOf(MARKER))
    expect(parsed.nodes.map(node => [node.label, node.title, node.volume])).toEqual([
      ['总览', '', undefined],
      ['第1–20章', '核对记录', '第一卷'],
      ['第21章', '破门', undefined],
      ['第22–100章', '反噬', '第二卷'],
    ])
    expect(synopsisNodeBody(parsed.nodes[1])).toContain('林舟逐条核对旧案记录')
    expect(synopsisNodeBody(parsed.nodes[3])).toBe('记忆损耗的代价持续推进，并在终局兑现。')
    expect(synopsisNodeBody(parsed.nodes[3])).not.toContain('本大纲已覆盖至')
    expect(synopsisNodeBody(parsed.nodes[0])).toBe('全书围绕灵脉异变展开，主角从铁砧镇一路追查到终局。')
    expect(maxCoveredChapter(parsed.nodes)).toBe(100)
  })

  it('falls back to one whole-document node when no chapter labels exist', () => {
    const text = '# 情节大纲\n\n第一幕：主角失去家园。\n\n第二幕：主角夺回主动权。\n'
    const parsed = parseSynopsis(text)

    expect(parsed.hasChapterLabels).toBe(false)
    expect(parsed.nodes).toHaveLength(1)
    expect(parsed.nodes[0].label).toBe('全文')
    expect(synopsisNodeBody(parsed.nodes[0])).toBe('第一幕：主角失去家园。\n\n第二幕：主角夺回主动权。')
  })

  it('returns no nodes for an empty outline', () => {
    expect(parseSynopsis('').nodes).toEqual([])
    expect(parseSynopsis('# 情节大纲\n').nodes).toEqual([])
  })
})

describe('replaceSynopsisNodeBody', () => {
  it('rewrites only the edited node and keeps every other byte', () => {
    const parsed = parseSynopsis(outline)
    const next = replaceSynopsisNodeBody(outline, parsed.nodes[2], '林舟破门而入，却发现传承早已被人取走。')

    expect(next).toBe(outline.replace(
      '宗门废墟之下，林舟第一次触碰旧铁锤里的传承。',
      '林舟破门而入，却发现传承早已被人取走。',
    ))
    expect(next).toContain(MARKER)
    const reparsed = parseSynopsis(next)
    expect(reparsed.nodes.map(node => node.label)).toEqual(['总览', '第1–20章', '第21章', '第22–100章'])
    expect(synopsisNodeBody(reparsed.nodes[2])).toBe('林舟破门而入，却发现传承早已被人取走。')
    expect(synopsisNodeBody(reparsed.nodes[1])).toBe(synopsisNodeBody(parsed.nodes[1]))
  })

  it('keeps the batch marker directly after the last node body', () => {
    const parsed = parseSynopsis(outline)
    const last = parsed.nodes[3]
    const next = replaceSynopsisNodeBody(outline, last, '记忆代价在终局一次性兑现。')

    expect(next.endsWith(`${MARKER}\n`)).toBe(true)
    expect(next).toContain('记忆代价在终局一次性兑现。\n\n' + MARKER)
    expect(parseSynopsis(next).markerStart).not.toBeNull()
  })

  it('clears a node body without gluing the neighbouring headings together', () => {
    const parsed = parseSynopsis(outline)
    const next = replaceSynopsisNodeBody(outline, parsed.nodes[1], '   ')

    expect(next).not.toContain('林舟逐条核对旧案记录')
    expect(next).toContain('第1–20章：核对记录\n\n第21章：破门')
    expect(parseSynopsis(next).nodes).toHaveLength(4)
  })
})
