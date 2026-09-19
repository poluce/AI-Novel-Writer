import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, initProjectDatabase } from '../../database'
import { DraftAnnotationRepository } from '../draft-annotation-repository'
import { DraftRepository } from '../draft-repository'

let projectRoot = ''

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-draft-notes-'))
  initProjectDatabase(projectRoot)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

describe('DraftAnnotationRepository', () => {
  it('replaces and lists annotations for a draft', () => {
    const draftId = DraftRepository.create({
      chapterNumber: 1,
      source: 'write',
      content: '顾舟停在潮门口。',
      wordCount: 8,
    })
    DraftAnnotationRepository.replace(draftId, [{
      id: 'note-1',
      from: 0,
      to: 3,
      quote: '顾舟停',
      note: '停得太突然，加一点犹豫',
      createdAt: 10,
    }])
    expect(DraftAnnotationRepository.list(draftId)).toEqual([
      {
        id: 'note-1',
        from: 0,
        to: 3,
        quote: '顾舟停',
        note: '停得太突然，加一点犹豫',
        resolved: false,
        createdAt: 10,
      },
    ])
    DraftAnnotationRepository.replace(draftId, [])
    expect(DraftAnnotationRepository.list(draftId)).toEqual([])
  })

  it('resolves annotations and filters out resolved ones by default', () => {
    const draftId = DraftRepository.create({
      chapterNumber: 1,
      source: 'write',
      content: '第一句。第二句。第三句。',
      wordCount: 12,
    })

    DraftAnnotationRepository.replace(draftId, [
      { id: 'note-1', from: 0, to: 3, quote: '第一句', note: '意见1', createdAt: 10 },
      { id: 'note-2', from: 4, to: 7, quote: '第二句', note: '意见2', createdAt: 20 },
      { id: 'note-3', from: 8, to: 11, quote: '第三句', note: '意见3', createdAt: 30 },
    ])

    expect(DraftAnnotationRepository.list(draftId)).toHaveLength(3)

    // 单个解决 note-1
    const count = DraftAnnotationRepository.resolve(draftId, ['note-1'])
    expect(count).toBe(1)

    // 默认 list 过滤掉已解决的 note-1，只剩 2 条
    const active = DraftAnnotationRepository.list(draftId)
    expect(active).toHaveLength(2)
    expect(active.map(a => a.id)).toEqual(['note-2', 'note-3'])

    // includeResolved: true 可查出全部 3 条，note-1 为 resolved: true
    const all = DraftAnnotationRepository.list(draftId, { includeResolved: true })
    expect(all).toHaveLength(3)
    expect(all.find(a => a.id === 'note-1')?.resolved).toBe(true)
    expect(all.find(a => a.id === 'note-2')?.resolved).toBe(false)

    // 全部解决 (resolve all)
    DraftAnnotationRepository.resolve(draftId, 'all')
    expect(DraftAnnotationRepository.list(draftId)).toHaveLength(0)
    expect(DraftAnnotationRepository.list(draftId, { includeResolved: true })).toHaveLength(3)
  })
})
