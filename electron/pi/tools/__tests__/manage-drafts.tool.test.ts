import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createManageDraftsTool } from '../manage-drafts.tool'
import { DraftRepository } from '../../../repositories/draft-repository'
import { DraftAnnotationRepository } from '../../../repositories/draft-annotation-repository'
import * as databaseModule from '../../../database'

vi.mock('../../../repositories/draft-repository', () => ({
  DraftRepository: {
    listByChapter: vi.fn(),
    getLatestByChapter: vi.fn(),
    getFinalizedByChapter: vi.fn(),
    getMeta: vi.fn(),
    getFull: vi.fn(),
    create: vi.fn(),
    updateContent: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('../../../repositories/draft-annotation-repository', () => ({
  DraftAnnotationRepository: {
    list: vi.fn(),
    replace: vi.fn(),
  },
}))

vi.mock('../../../database', () => ({
  getCurrentProjectPath: vi.fn(),
  getProjectDb: vi.fn(),
}))

function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
  const first = res.content[0]
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('expected text content')
  }
  return first.text
}

describe('manage_drafts tool', () => {
  let emittedActions: unknown[]

  const rendererAction = vi.fn(async (action: unknown) => {
    emittedActions.push(action)
    if (typeof action === 'object' && action && 'type' in action && action.type === 'replace_draft_excerpt') {
      return { ok: true as const, summary: '已在第 1 章草稿中替换一处原文（3 → 5 字）。' }
    }
    return { ok: true as const, summary: '已同步草稿数据与界面状态' }
  })

  beforeEach(() => {
    vi.clearAllMocks()
    emittedActions = []

    vi.mocked(databaseModule.getCurrentProjectPath).mockReturnValue('/workspace/novel')
    vi.mocked(databaseModule.getProjectDb).mockReturnValue({} as never)
    vi.mocked(DraftAnnotationRepository.list).mockReturnValue([])
  })

  // =========================================================================
  // 1. 读取 (read)
  // =========================================================================
  describe('read operation', () => {
    it('reads the latest draft by default', async () => {
      vi.mocked(DraftRepository.listByChapter).mockReturnValue([
        { id: 1, chapterNumber: 1, version: 1, status: 'draft', source: 'write', contentId: 1, wordCount: 1500, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-18', updatedAt: '2026-09-18' },
        { id: 2, chapterNumber: 1, version: 2, status: 'revised', source: 'rewrite', contentId: 2, wordCount: 2200, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-19', updatedAt: '2026-09-19' },
      ])
      vi.mocked(DraftRepository.getLatestByChapter).mockReturnValue({
        id: 2, chapterNumber: 1, version: 2, status: 'revised', source: 'rewrite', contentId: 2, wordCount: 2200, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-19', updatedAt: '2026-09-19',
      })
      vi.mocked(DraftRepository.getFull).mockReturnValue({
        id: 2, chapterNumber: 1, version: 2, status: 'revised', source: 'rewrite', contentId: 2, wordCount: 2200, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-19', updatedAt: '2026-09-19',
        content: '第一行正文\n第二行正文\n第三行正文',
      })

      const tool = createManageDraftsTool('zh-CN', rendererAction)
      const res = await tool.execute('c1', { action: 'read', chapter_number: 1 })

      expect(res.details.version).toBe(2)
      expect(res.details.wordCount).toBe(2200)
      const text = textOf(res)
      expect(text).toContain('Draft v2')
      expect(text).toContain('第一行正文')
      expect(text).toContain('第三行正文')
    })

    it('reads a specific draft version when version is requested', async () => {
      vi.mocked(DraftRepository.listByChapter).mockReturnValue([
        { id: 1, chapterNumber: 1, version: 1, status: 'draft', source: 'write', contentId: 1, wordCount: 1500, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-18', updatedAt: '2026-09-18' },
        { id: 2, chapterNumber: 1, version: 2, status: 'revised', source: 'rewrite', contentId: 2, wordCount: 2200, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-19', updatedAt: '2026-09-19' },
      ])
      vi.mocked(DraftRepository.getFull).mockReturnValue({
        id: 1, chapterNumber: 1, version: 1, status: 'draft', source: 'write', contentId: 1, wordCount: 1500, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-18', updatedAt: '2026-09-18',
        content: 'v1 历史草稿',
      })

      const tool = createManageDraftsTool('zh-CN', rendererAction)
      const res = await tool.execute('c2', { action: 'read', chapter_number: 1, version: 1 })

      expect(res.details.version).toBe(1)
      expect(textOf(res)).toContain('Draft v1')
      expect(textOf(res)).toContain('v1 历史草稿')
    })

    it('supports line-level pagination with offset and limit', async () => {
      vi.mocked(DraftRepository.listByChapter).mockReturnValue([
        { id: 1, chapterNumber: 2, version: 1, status: 'draft', source: 'write', contentId: 1, wordCount: 3000, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-18', updatedAt: '2026-09-18' },
      ])
      const lines = ['行1', '行2', '行3', '行4', '行5'].join('\n')
      vi.mocked(DraftRepository.getFull).mockReturnValue({
        id: 1, chapterNumber: 2, version: 1, status: 'draft', source: 'write', contentId: 1, wordCount: 3000, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-18', updatedAt: '2026-09-18',
        content: lines,
      })

      const tool = createManageDraftsTool('zh-CN', rendererAction)
      const res = await tool.execute('c3', { action: 'read', chapter_number: 2, offset: 2, limit: 2 })

      expect(res.details.offset).toBe(2)
      expect(res.details.limit).toBe(2)
      const text = textOf(res)
      expect(text).toContain('行2')
      expect(text).toContain('行3')
      expect(text).not.toContain('行1')
      expect(text).not.toContain('行4')
    })

    it('throws when chapter has no drafts', async () => {
      vi.mocked(DraftRepository.listByChapter).mockReturnValue([])

      const tool = createManageDraftsTool('zh-CN', rendererAction)
      await expect(tool.execute('c4', { action: 'read', chapter_number: 99 }))
        .rejects.toThrow('第 99 章暂无任何草稿')
    })

    it('automatically includes author annotations when annotations exist', async () => {
      vi.mocked(DraftRepository.listByChapter).mockReturnValue([
        { id: 3, chapterNumber: 1, version: 1, status: 'draft', source: 'write', contentId: 3, wordCount: 1800, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-18', updatedAt: '2026-09-18' },
      ])
      vi.mocked(DraftRepository.getLatestByChapter).mockReturnValue({
        id: 3, chapterNumber: 1, version: 1, status: 'draft', source: 'write', contentId: 3, wordCount: 1800, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-18', updatedAt: '2026-09-18',
      })
      vi.mocked(DraftRepository.getFull).mockReturnValue({
        id: 3, chapterNumber: 1, version: 1, status: 'draft', source: 'write', contentId: 3, wordCount: 1800, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-18', updatedAt: '2026-09-18',
        content: '这是正文段落。顾岩拔剑刺来。陆舟身形一晃避开。',
      })
      vi.mocked(DraftAnnotationRepository.list).mockReturnValue([
        { id: 'ann-1', from: 7, to: 13, quote: '顾岩拔剑刺来', note: '这里动作太死板，改为暗器突袭', createdAt: 1700000000000 },
      ])

      const tool = createManageDraftsTool('zh-CN', rendererAction)
      const res = await tool.execute('c1-ann', { action: 'read', chapter_number: 1 })

      expect(res.details.annotationsCount).toBe(1)
      const text = textOf(res)
      expect(text).toContain('本章作者划词标注')
      expect(text).toContain('顾岩拔剑刺来')
      expect(text).toContain('这里动作太死板，改为暗器突袭')
    })
  })

  // =========================================================================
  // 2. 划词标注清单 (list_annotations)
  // =========================================================================
  describe('list_annotations operation', () => {
    it('returns author annotations for the specified chapter draft', async () => {
      vi.mocked(DraftRepository.listByChapter).mockReturnValue([
        { id: 4, chapterNumber: 2, version: 1, status: 'draft', source: 'write', contentId: 4, wordCount: 2000, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-18', updatedAt: '2026-09-18' },
      ])
      vi.mocked(DraftRepository.getLatestByChapter).mockReturnValue({
        id: 4, chapterNumber: 2, version: 1, status: 'draft', source: 'write', contentId: 4, wordCount: 2000, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-18', updatedAt: '2026-09-18',
      })
      vi.mocked(DraftAnnotationRepository.list).mockReturnValue([
        { id: 'ann-2', from: 10, to: 20, quote: '林间微风吹拂', note: '环境描写不够凝重，加一点肃杀感', createdAt: 1700000001000 },
      ])

      const tool = createManageDraftsTool('zh-CN', rendererAction)
      const res = await tool.execute('c-ann-list', { action: 'list_annotations', chapter_number: 2 })

      expect(res.details.totalAnnotations).toBe(1)
      const text = textOf(res)
      expect(text).toContain('林间微风吹拂')
      expect(text).toContain('环境描写不够凝重，加一点肃杀感')
    })

    it('reports friendly notice when draft has no annotations', async () => {
      vi.mocked(DraftRepository.listByChapter).mockReturnValue([
        { id: 5, chapterNumber: 2, version: 1, status: 'draft', source: 'write', contentId: 5, wordCount: 2000, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-18', updatedAt: '2026-09-18' },
      ])
      vi.mocked(DraftRepository.getLatestByChapter).mockReturnValue({
        id: 5, chapterNumber: 2, version: 1, status: 'draft', source: 'write', contentId: 5, wordCount: 2000, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-18', updatedAt: '2026-09-18',
      })
      vi.mocked(DraftAnnotationRepository.list).mockReturnValue([])

      const tool = createManageDraftsTool('zh-CN', rendererAction)
      const res = await tool.execute('c-ann-empty', { action: 'list_annotations', chapter_number: 2 })

      expect(res.details.totalAnnotations).toBe(0)
      expect(textOf(res)).toContain('目前暂无作者划词标注意见')
    })

    it('reports friendly notice when chapter has no drafts', async () => {
      vi.mocked(DraftRepository.listByChapter).mockReturnValue([])

      const tool = createManageDraftsTool('zh-CN', rendererAction)
      const res = await tool.execute('c-ann-nodraft', { action: 'list_annotations', chapter_number: 99 })

      expect(res.details.totalAnnotations).toBe(0)
      expect(textOf(res)).toContain('暂无任何草稿记录')
    })
  })

  // =========================================================================
  // 3. 版本清单 (list_versions)
  // =========================================================================
  describe('list_versions operation', () => {
    it('lists all versions of a chapter', async () => {
      vi.mocked(DraftRepository.listByChapter).mockReturnValue([
        { id: 10, chapterNumber: 3, version: 1, status: 'draft', source: 'write', contentId: 10, wordCount: 2000, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-18', updatedAt: '2026-09-18' },
        { id: 11, chapterNumber: 3, version: 2, status: 'finalized', source: 'rewrite', contentId: 11, wordCount: 2500, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-19', updatedAt: '2026-09-19' },
      ])

      const tool = createManageDraftsTool('zh-CN', rendererAction)
      const res = await tool.execute('c5', { action: 'list_versions', chapter_number: 3 })

      expect(res.details.totalVersions).toBe(2)
      const text = textOf(res)
      expect(text).toContain('第 3 章草稿版本清单')
      expect(text).toContain('Draft v1')
      expect(text).toContain('Draft v2')
      expect(text).toContain('已定稿')
    })

    it('reports no drafts guidance if empty', async () => {
      vi.mocked(DraftRepository.listByChapter).mockReturnValue([])

      const tool = createManageDraftsTool('zh-CN', rendererAction)
      const res = await tool.execute('c6', { action: 'list_versions', chapter_number: 4 })

      expect(res.details.totalVersions).toBe(0)
      expect(textOf(res)).toContain('暂无任何草稿记录')
    })
  })

  // =========================================================================
  // 3. 写入 (write - 新建首版 / 追加新版 / 覆盖未定稿)
  // =========================================================================
  describe('write operation', () => {
    it('creates initial draft v1 when chapter has no drafts', async () => {
      vi.mocked(DraftRepository.listByChapter).mockReturnValue([])
      vi.mocked(DraftRepository.create).mockReturnValue(101)
      vi.mocked(DraftRepository.getMeta).mockReturnValue({
        id: 101, chapterNumber: 1, version: 1, status: 'draft', source: 'write', contentId: 101, wordCount: 2000, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-19', updatedAt: '2026-09-19',
      })

      const tool = createManageDraftsTool('zh-CN', rendererAction)
      const res = await tool.execute('c7', {
        action: 'write',
        chapter_number: 1,
        content: '这是由项目助手为第 1 章直接撰写的全新正文草稿，字数充沛，描写生动。',
      })

      expect(res.details.draftId).toBe(101)
      expect(res.details.version).toBe(1)
      expect(DraftRepository.create).toHaveBeenCalledWith(expect.objectContaining({
        chapterNumber: 1,
        source: 'write',
      }))
      expect(emittedActions).toContainEqual(expect.objectContaining({
        type: 'sync_draft_content',
        chapterNumber: 1,
        draftId: 101,
        isNewVersion: true,
      }))
    })

    it('creates next version (Draft v2) for whole-chapter rewrite', async () => {
      vi.mocked(DraftRepository.listByChapter).mockReturnValue([
        { id: 1, chapterNumber: 1, version: 1, status: 'draft', source: 'write', contentId: 1, wordCount: 1500, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-18', updatedAt: '2026-09-18' },
      ])
      vi.mocked(DraftRepository.create).mockReturnValue(102)
      vi.mocked(DraftRepository.getMeta).mockReturnValue({
        id: 102, chapterNumber: 1, version: 2, status: 'draft', source: 'rewrite', contentId: 102, wordCount: 2800, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-19', updatedAt: '2026-09-19',
      })

      const tool = createManageDraftsTool('zh-CN', rendererAction)
      const res = await tool.execute('c8', {
        action: 'write',
        chapter_number: 1,
        mode: 'new_version',
        content: '推倒重写后的第二版完整正文。',
      })

      expect(res.details.version).toBe(2)
      expect(DraftRepository.create).toHaveBeenCalledWith(expect.objectContaining({
        chapterNumber: 1,
        source: 'rewrite',
      }))
    })

    it('overwrites unfinalized draft when mode is overwrite', async () => {
      vi.mocked(DraftRepository.listByChapter).mockReturnValue([
        { id: 5, chapterNumber: 1, version: 1, status: 'draft', source: 'write', contentId: 5, wordCount: 1500, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-18', updatedAt: '2026-09-18' },
      ])
      vi.mocked(DraftRepository.getLatestByChapter).mockReturnValue({
        id: 5, chapterNumber: 1, version: 1, status: 'draft', source: 'write', contentId: 5, wordCount: 1500, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-18', updatedAt: '2026-09-18',
      })

      const tool = createManageDraftsTool('zh-CN', rendererAction)
      const res = await tool.execute('c9', {
        action: 'write',
        chapter_number: 1,
        mode: 'overwrite',
        content: '覆盖更新后的正文。',
      })

      expect(res.details.mode).toBe('overwrite')
      expect(DraftRepository.updateContent).toHaveBeenCalledWith(5, '覆盖更新后的正文。', expect.any(Number))
      expect(DraftAnnotationRepository.replace).toHaveBeenCalledWith(5, [])
      expect(emittedActions).toContainEqual(expect.objectContaining({
        type: 'sync_draft_content',
        chapterNumber: 1,
        draftId: 5,
        isNewVersion: false,
      }))
    })

    it('strictly forbids overwrite if draft is finalized', async () => {
      vi.mocked(DraftRepository.listByChapter).mockReturnValue([
        { id: 9, chapterNumber: 1, version: 1, status: 'finalized', source: 'write', contentId: 9, wordCount: 2000, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-18', updatedAt: '2026-09-18' },
      ])
      vi.mocked(DraftRepository.getLatestByChapter).mockReturnValue({
        id: 9, chapterNumber: 1, version: 1, status: 'finalized', source: 'write', contentId: 9, wordCount: 2000, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-18', updatedAt: '2026-09-18',
      })

      const tool = createManageDraftsTool('zh-CN', rendererAction)
      await expect(tool.execute('c10', {
        action: 'write',
        chapter_number: 1,
        mode: 'overwrite',
        content: '企图强行覆盖已定稿正文',
      })).rejects.toThrow('已经定稿锁定，严禁覆盖修改')
    })
  })

  // =========================================================================
  // 4. 指定位置无损局部替换 (replace_excerpt)
  // =========================================================================
  describe('replace_excerpt operation', () => {
    it('invokes renderer action for passage replacement', async () => {
      const tool = createManageDraftsTool('zh-CN', rendererAction)
      const res = await tool.execute('c11', {
        action: 'replace_excerpt',
        chapter_number: 1,
        old_text: '他走了',
        new_text: '他悄然离开了',
      })

      expect(rendererAction).toHaveBeenCalledWith(expect.objectContaining({
        type: 'replace_draft_excerpt',
        chapterNumber: 1,
        oldText: '他走了',
        newText: '他悄然离开了',
      }))
      expect(textOf(res)).toContain('替换一处原文')
    })

    it('rejects empty old_text in replace_excerpt', async () => {
      const tool = createManageDraftsTool('zh-CN', rendererAction)
      await expect(tool.execute('c12', {
        action: 'replace_excerpt',
        chapter_number: 1,
        old_text: '',
        new_text: '新文本',
      })).rejects.toThrow('缺少要替换的原文 old_text')
    })
  })

  // =========================================================================
  // 5. 删除未定稿草稿 (delete)
  // =========================================================================
  describe('delete operation', () => {
    it('deletes unfinalized draft version', async () => {
      vi.mocked(DraftRepository.getMeta).mockReturnValue({
        id: 15, chapterNumber: 2, version: 3, status: 'draft', source: 'rewrite', contentId: 15, wordCount: 1000, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-18', updatedAt: '2026-09-18',
      })

      const tool = createManageDraftsTool('zh-CN', rendererAction)
      const res = await tool.execute('c13', {
        action: 'delete',
        chapter_number: 2,
        draft_id: 15,
      })

      expect(res.details.deletedId).toBe(15)
      expect(DraftRepository.delete).toHaveBeenCalledWith(15)
      expect(emittedActions).toContainEqual(expect.objectContaining({
        type: 'sync_draft_content',
        chapterNumber: 2,
        draftId: 15,
      }))
    })

    it('rejects deletion if draft is finalized', async () => {
      vi.mocked(DraftRepository.getMeta).mockReturnValue({
        id: 16, chapterNumber: 2, version: 1, status: 'finalized', source: 'write', contentId: 16, wordCount: 2000, sourceDependencies: [], dependenciesStale: false, createdAt: '2026-09-18', updatedAt: '2026-09-18',
      })

      const tool = createManageDraftsTool('zh-CN', rendererAction)
      await expect(tool.execute('c14', {
        action: 'delete',
        chapter_number: 2,
        draft_id: 16,
      })).rejects.toThrow('已定稿草稿为不可变最终事实，严禁删除')
    })
  })
})
