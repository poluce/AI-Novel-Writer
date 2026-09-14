import { describe, expect, it } from 'vitest'

import {
  buildChapterBlueprintProposal,
  buildNovelConfigProposal,
} from '../domain-proposals'
import type { BlueprintData } from '../blueprint'
import type { NovelConfig } from '../ipc-channels'

const text = (_zhCN: string, enUS: string) => enUS

const novelConfig = {
  genre: '奇幻', subGenre: '', targetAudience: '青年', totalChapters: 10, wordsPerChapter: 3000,
  plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '旧大纲', worldSetting: '',
  goldenFinger: '', protagonistProfile: '', globalGuidance: '',
} as unknown as NovelConfig

const blueprint = {
  chapterNumber: 2, title: '旧标题', role: '发展', purpose: '推进调查', keyEvents: '找到线索',
  characters: ['林舟'], suspenseHook: '谁在说谎', userGuidance: '', notes: '',
} as BlueprintData

describe('buildNovelConfigProposal', () => {
  it('normalizes field names and enum aliases and reports per-field diffs', () => {
    const proposal = buildNovelConfigProposal({
      changes: { narrativePov: 'first_person', writingLanguage: 'English', genre: '科幻' },
    }, novelConfig, text)

    expect(proposal).toMatchObject({
      valid: true,
      changes: { narrativePOV: 'first_person', writingLanguage: 'en-US', genre: '科幻' },
    })
    if (!proposal.valid) throw new Error('expected a valid proposal')
    expect(proposal.diffs).toEqual([
      { field: 'narrativePOV', current: 'third_limited', proposed: 'first_person' },
      { field: 'writingLanguage', current: undefined, proposed: 'en-US' },
      { field: 'genre', current: '奇幻', proposed: '科幻' },
    ])
  })

  it('rejects unknown fields, wrong types, and unsupported enum values', () => {
    const unknown = buildNovelConfigProposal({ changes: { theme: 'x' } }, novelConfig, text)
    expect(unknown).toMatchObject({ valid: false, error: 'Unknown novel configuration field: theme' })

    const wrongType = buildNovelConfigProposal({ changes: { totalChapters: 0 } }, novelConfig, text)
    expect(wrongType).toMatchObject({ valid: false, error: 'Field totalChapters must be a positive integer' })

    const badEnum = buildNovelConfigProposal({ changes: { plotStructure: 'four_act' } }, novelConfig, text)
    expect(badEnum).toMatchObject({ valid: false })
    expect(badEnum.valid ? '' : badEnum.error).toContain('unsupported value')

    expect(buildNovelConfigProposal({ changes: {} }, novelConfig, text))
      .toMatchObject({ valid: false, error: 'No novel configuration changes were provided' })
  })
})

describe('buildChapterBlueprintProposal', () => {
  it('accepts canonical fields and normalizes the author-guidance alias', () => {
    const proposal = buildChapterBlueprintProposal({
      chapter_number: 2,
      changes: { title: '新标题', 作者微操指导: '收紧节奏', characters: ['林舟', '苏绾'] },
    }, blueprint, text)

    expect(proposal).toMatchObject({
      valid: true,
      chapterNumber: 2,
      changes: { title: '新标题', userGuidance: '收紧节奏', characters: ['林舟', '苏绾'] },
    })
    if (!proposal.valid) throw new Error('expected a valid proposal')
    expect(proposal.diffs).toEqual([
      { field: 'title', current: '旧标题', proposed: '新标题' },
      { field: 'userGuidance', current: '', proposed: '收紧节奏' },
      { field: 'characters', current: ['林舟'], proposed: ['林舟', '苏绾'] },
    ])
  })

  it('rejects a chapter mismatch, unknown fields, and non-text character lists', () => {
    expect(buildChapterBlueprintProposal({ chapter_number: 3, changes: { title: 'x' } }, blueprint, text))
      .toMatchObject({ valid: false, error: 'The target chapter does not match the current blueprint' })
    expect(buildChapterBlueprintProposal({ chapter_number: 2, changes: { pacing: 'x' } }, blueprint, text))
      .toMatchObject({ valid: false, error: 'Unknown chapter blueprint field: pacing' })
    expect(buildChapterBlueprintProposal({ chapter_number: 2, changes: { characters: [1] } }, blueprint, text))
      .toMatchObject({ valid: false, error: 'Field characters must be an array of text values' })
  })
})
