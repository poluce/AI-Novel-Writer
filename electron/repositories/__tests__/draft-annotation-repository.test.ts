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
        createdAt: 10,
      },
    ])
    DraftAnnotationRepository.replace(draftId, [])
    expect(DraftAnnotationRepository.list(draftId)).toEqual([])
  })
})
