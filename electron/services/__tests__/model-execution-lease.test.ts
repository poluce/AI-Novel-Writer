import { describe, expect, it } from 'vitest'

import type { ModelProfile } from '../../../src/shared/ipc-channels'
import {
  resolveModelExecutionCapabilityEvidence,
} from '../model-execution-lease'

const ORIGINAL_KEY = 'lease-test-secret-original'

function modelProfile(): ModelProfile {
  return {
    id: 'generation-model',
    name: 'Generation Model',
    provider: 'deepseek',
    protocol: 'openai',
    modelName: 'deepseek-v4-flash',
    apiKey: ORIGINAL_KEY,
    baseUrl: 'https://api.deepseek.com',
    temperature: 0.7,
    maxTokens: 8192,
    capabilities: {
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 8192,
      reasoning: false,
      structuredOutput: true,
      usage: true,
    },
    purposes: ['generation'],
  }
}

describe('model execution capability evidence', () => {
  it('clamps an unknown endpoint output plan to its explicit finite context limit and respects declared capabilities', () => {
    const profile: ModelProfile = {
      ...modelProfile(),
      provider: 'custom',
      modelName: 'future-compatible-model',
      baseUrl: 'https://future.example.com/v1',
      maxTokens: 65_536,
      capabilities: {
        contextWindowTokens: 32_768,
        maxOutputTokens: 65_536,
        reasoning: true,
        structuredOutput: true,
        usage: true,
      },
    }

    expect(resolveModelExecutionCapabilityEvidence(profile)).toMatchObject({
      source: {
        contextWindowTokens: 'user-operational-cap',
        maxOutputTokens: 'user-operational-cap',
        featureFlags: 'user-operational-cap',
      },
      contextWindowTokens: 32_768,
      maxOutputTokens: 32_768,
      reasoning: true,
      structuredOutput: true,
      usage: true,
    })
  })

  it('resolves exact official Gemini capabilities for structured planning', () => {
    const profile: ModelProfile = {
      ...modelProfile(),
      id: 'gemini-lite',
      provider: 'gemini',
      protocol: 'gemini',
      modelName: 'gemini-2.5-flash-lite',
      baseUrl: 'https://generativelanguage.googleapis.com',
      maxTokens: 65_536,
      capabilities: undefined,
    }

    expect(resolveModelExecutionCapabilityEvidence(profile)).toMatchObject({
      source: {
        contextWindowTokens: 'verified-provider-preset',
        maxOutputTokens: 'verified-provider-preset',
        featureFlags: 'verified-provider-preset',
      },
      contextWindowTokens: 1_048_576,
      maxOutputTokens: 65_536,
      reasoning: true,
      structuredOutput: true,
      usage: true,
    })
  })

  it('resolves capabilities from Pi-AI model registry when model is absent from local preset dictionary', () => {
    const profile: ModelProfile = {
      ...modelProfile(),
      id: 'qwen-model',
      provider: 'custom',
      protocol: 'openai',
      modelName: 'qwen3.7-plus',
      baseUrl: 'https://my-proxy.com/v1',
      maxTokens: 8192,
      capabilities: undefined,
    }

    const evidence = resolveModelExecutionCapabilityEvidence(profile)
    expect(evidence).toMatchObject({
      source: {
        contextWindowTokens: 'pi-ai-model-registry',
        featureFlags: 'pi-ai-model-registry',
      },
      reasoning: true,
      structuredOutput: true,
      usage: true,
    })
    expect(evidence.contextWindowTokens).toBeGreaterThanOrEqual(128_000)
    expect(evidence.maxOutputTokens).toBe(8192)
  })
})
