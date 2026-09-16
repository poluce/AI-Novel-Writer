import { describe, expect, it } from 'vitest'

import {
  acceptedAssistantThinkingLevel,
  channelHasModel,
  groupModelsByChannel,
  isAssistantThinkingLevel,
  modelChannelKey,
  modelChannelLabel,
} from '../agent-runtime'
import type { ModelProfile } from '../ipc-channels'

function profile(overrides: Partial<ModelProfile> & { id: string }): ModelProfile {
  return {
    name: overrides.id,
    provider: 'gemini',
    protocol: 'gemini',
    modelName: 'gemini-3.8-flash',
    apiKey: 'k',
    baseUrl: 'https://relay.example/antigravity',
    temperature: 0.7,
    maxTokens: 65530,
    purposes: ['generation'],
    ...overrides,
  }
}

describe('assistant thinking levels', () => {
  it('accepts only the four levels the composer can send', () => {
    for (const level of ['off', 'low', 'medium', 'high']) {
      expect(isAssistantThinkingLevel(level)).toBe(true)
      expect(acceptedAssistantThinkingLevel(level)).toBe(level)
    }
    for (const level of ['minimal', 'xhigh', 'max', 'OFF', '', 3, null, undefined, {}]) {
      expect(isAssistantThinkingLevel(level)).toBe(false)
      expect(acceptedAssistantThinkingLevel(level)).toBeUndefined()
    }
  })
})

describe('channel grouping', () => {
  it('treats provider + protocol + baseUrl as one channel, ignoring a trailing slash', () => {
    const a = profile({ id: 'a', baseUrl: 'https://relay.example/antigravity' })
    const b = profile({ id: 'b', baseUrl: 'https://relay.example/antigravity/' })
    expect(modelChannelKey(a)).toBe(modelChannelKey(b))
    expect(modelChannelLabel(a)).toBe('relay.example')
  })

  it('lists every model of a channel under one group, sorted by model name', () => {
    const groups = groupModelsByChannel([
      profile({ id: 'a', modelName: 'gemini-3.8-flash-high' }),
      profile({ id: 'b', modelName: 'gemini-3.1-pro-low' }),
      profile({ id: 'c', modelName: 'gemini-3-flash', provider: 'openai', protocol: 'openai', baseUrl: 'https://api.example/v1' }),
    ])

    expect(groups).toHaveLength(2)
    expect(groups[0].label).toBe('relay.example')
    expect(groups[0].models.map(entry => entry.modelName)).toEqual([
      'gemini-3.1-pro-low',
      'gemini-3.8-flash-high',
    ])
    expect(groups[1].label).toBe('api.example')
  })

  it('keeps one entry per model name even when the same one is saved twice', () => {
    const groups = groupModelsByChannel([
      profile({ id: 'a' }),
      profile({ id: 'b' }),
    ])
    expect(groups[0].models).toHaveLength(1)
  })

  it('skips profiles without a model name', () => {
    const groups = groupModelsByChannel([profile({ id: 'a', modelName: '   ' })])
    expect(groups[0].models).toHaveLength(0)
  })

  it('detects a model that is already configured on the channel', () => {
    const existing = [profile({ id: 'a', modelName: 'gemini-3.8-flash' })]
    const channel = {
      provider: 'gemini' as const,
      protocol: 'gemini' as const,
      baseUrl: 'https://relay.example/antigravity/',
    }

    expect(channelHasModel(existing, channel, 'gemini-3.8-flash')).toBe(true)
    expect(channelHasModel(existing, channel, 'gemini-3.8-flash-low')).toBe(false)
    expect(channelHasModel(existing, { ...channel, baseUrl: 'https://other.example' }, 'gemini-3.8-flash')).toBe(false)
  })

  it('preserves custom channelName and groups all models under that channel', () => {
    const groups = groupModelsByChannel([
      profile({ id: 'a', channelName: 'hajimi', modelName: 'gemini-3.8-flash-high' }),
      profile({ id: 'b', channelName: 'hajimi', modelName: 'gemini-3.1-pro-low' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].channelName).toBe('hajimi')
    expect(groups[0].models).toHaveLength(2)
  })
})
