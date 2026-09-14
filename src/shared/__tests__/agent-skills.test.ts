import { describe, expect, it } from 'vitest'

import {
  AGENT_SKILL_CATALOG_MAX_ENTRIES,
  AGENT_SKILL_DESCRIPTION_MAX_CHARS,
  isAgentSkillCatalog,
} from '../agent-skills'

import type { AgentSkillCatalogEntry } from '../agent-skills'

function entry(overrides: Partial<AgentSkillCatalogEntry> = {}): AgentSkillCatalogEntry {
  return {
    name: 'scene-craft',
    description: '场景塑造',
    location: '/home/me/.vela/skills/scene-craft/SKILL.md',
    source: 'user',
    ...overrides,
  }
}

describe('isAgentSkillCatalog', () => {
  it('accepts a well-formed catalog', () => {
    expect(isAgentSkillCatalog([])).toBe(true)
    expect(isAgentSkillCatalog([entry(), entry({ source: 'builtin', disableModelInvocation: true })])).toBe(true)
  })

  it('rejects payloads the main-process prompt builder cannot render', () => {
    expect(isAgentSkillCatalog(undefined)).toBe(false)
    expect(isAgentSkillCatalog('skills')).toBe(false)
    expect(isAgentSkillCatalog([{ ...entry(), name: 42 }])).toBe(false)
    expect(isAgentSkillCatalog([{ ...entry(), name: '' }])).toBe(false)
    expect(isAgentSkillCatalog([{ ...entry(), location: undefined }])).toBe(false)
    expect(isAgentSkillCatalog([{ ...entry(), source: 'remote' }])).toBe(false)
    expect(isAgentSkillCatalog([{ ...entry(), disableModelInvocation: 'yes' }])).toBe(false)
    expect(isAgentSkillCatalog([null])).toBe(false)
  })

  it('rejects a catalog larger than the system-prompt budget', () => {
    const oversized = Array.from(
      { length: AGENT_SKILL_CATALOG_MAX_ENTRIES + 1 },
      (_, index) => entry({ name: `skill-${index}` }),
    )
    expect(isAgentSkillCatalog(oversized)).toBe(false)
  })

  it('keeps the description budget available to both sides', () => {
    expect(AGENT_SKILL_DESCRIPTION_MAX_CHARS).toBeGreaterThan(0)
    expect(AGENT_SKILL_CATALOG_MAX_ENTRIES).toBeGreaterThan(0)
  })
})
