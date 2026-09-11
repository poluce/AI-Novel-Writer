import { describe, expect, it } from 'vitest'

import {
  createSubmitTool,
  submitBlueprintTool,
  submitDraftTool,
  submitFieldTool,
  submitFinalizationTool,
  submitOutlineTool,
  submitReviewTool,
  submitRevisionTool,
  submitStyleAnalysisTool,
  submitTextTool,
  visibleTextFromSubmitArtifact,
} from '../submit-tools'

describe('submit contract tools', () => {
  it('exposes the one-shot submit_* identities', () => {
    expect(submitDraftTool().name).toBe('submit_draft')
    expect(submitRevisionTool().name).toBe('submit_revision')
    expect(submitFinalizationTool().name).toBe('submit_finalization')
    expect(submitReviewTool().name).toBe('submit_review')
    expect(submitOutlineTool().name).toBe('submit_outline')
    expect(submitBlueprintTool().name).toBe('submit_blueprint')
    expect(submitFieldTool().name).toBe('submit_field')
    expect(submitStyleAnalysisTool().name).toBe('submit_style_analysis')
    expect(submitTextTool().name).toBe('submit_text')
  })

  it('returns the submitted arguments as execute details', async () => {
    const params = { title: '第一章', body: '正文' }
    const result = await submitDraftTool().execute('call-1', params)

    expect(result.details).toEqual(params)
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(params) }])
  })

  it('keeps review items and optional goalReviews on the schema', () => {
    const schema = submitReviewTool().parameters as { properties?: Record<string, unknown> }
    expect(schema.properties).toHaveProperty('summary')
    expect(schema.properties).toHaveProperty('items')
    expect(schema.properties).toHaveProperty('goalReviews')
  })

  it('keeps the blueprint batch contract on the schema', () => {
    const schema = submitBlueprintTool().parameters as { properties?: Record<string, unknown> }
    expect(schema.properties).toHaveProperty('blueprints')
  })

  it('resolves submit_field by name', () => {
    expect(createSubmitTool('submit_field').name).toBe('submit_field')
  })

  it('prefers the field artifact value over visible text', () => {
    expect(visibleTextFromSubmitArtifact('submit_field', { value: '金手指' }, '旁白')).toBe('金手指')
    expect(visibleTextFromSubmitArtifact('submit_field', undefined, '旁白')).toBe('旁白')
  })

  it('maps style analysis and visible-text artifacts', () => {
    expect(visibleTextFromSubmitArtifact('submit_style_analysis', { analysis: '节奏偏快' }, '')).toBe('节奏偏快')
    expect(visibleTextFromSubmitArtifact('submit_text', { text: '润色后的句子' }, '')).toBe('润色后的句子')
  })

  it('keeps a review artifact even when the model also emitted visible text', () => {
    const artifact = {
      summary: '本章目标待核实',
      items: [{ category: 'continuity', severity: 'pass', description: '无漂移' }],
    }
    expect(visibleTextFromSubmitArtifact('submit_review', artifact, '旁白')).toBe(JSON.stringify(artifact))
  })
})
