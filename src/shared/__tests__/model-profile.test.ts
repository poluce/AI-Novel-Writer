import { describe, it, expect } from 'vitest'
import { normalizeModelProfile, normalizeModelProfiles } from '../model-profile'

describe('normalizeModelProfile', () => {
  it('supplies safe defaults for an empty or partial object', () => {
    const normalized = normalizeModelProfile({})
    expect(normalized.id).toBe('unknown')
    expect(normalized.name).toBe('Unnamed Model')
    expect(normalized.modelName).toBe('')
    expect(normalized.provider).toBe('custom')
    expect(normalized.protocol).toBe('openai')
    expect(normalized.apiKey).toBe('')
    expect(normalized.baseUrl).toBe('')
    expect(normalized.temperature).toBe(0.7)
    expect(normalized.maxTokens).toBe(4096)
    expect(normalized.purposes).toEqual(['generation', 'refinement', 'summary'])
  })

  it('migrates legacy google provider to gemini', () => {
    const normalized = normalizeModelProfile({
      id: 'prof-1',
      provider: 'google',
      modelName: 'gemini-2.5-pro',
    })
    expect(normalized.provider).toBe('gemini')
    expect(normalized.protocol).toBe('gemini')
    expect(normalized.name).toBe('gemini-2.5-pro')
  })

  it('infers embedding purpose when model name contains embedding or bge', () => {
    const normalized = normalizeModelProfile({
      id: 'prof-emb',
      modelName: 'BAAI/bge-m3',
    })
    expect(normalized.purposes).toEqual(['embedding'])
  })

  it('preserves valid explicit purposes', () => {
    const normalized = normalizeModelProfile({
      id: 'prof-2',
      modelName: 'custom-model',
      purposes: ['generation'],
    })
    expect(normalized.purposes).toEqual(['generation'])
  })

  it('normalizes an array of model profiles cleanly', () => {
    const list = normalizeModelProfiles([
      { id: '1', modelName: 'm1' },
      null,
      { id: '2', modelName: 'm2', purposes: ['embedding'] },
    ])
    expect(list).toHaveLength(3)
    expect(list[0].purposes).toEqual(['generation', 'refinement', 'summary'])
    expect(list[1].name).toBe('Unnamed Model')
    expect(list[2].purposes).toEqual(['embedding'])
  })
})
