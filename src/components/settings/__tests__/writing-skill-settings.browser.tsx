import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import SkillSettings from '../SkillSettings'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined
const invoke = vi.fn()
const originalProjectState = useProjectStore.getState()
const originalLocaleState = useLocaleStore.getState()

let diagnostics: unknown[] = []

function ipcResult(channel: string) {
  if ((channel === 'skills:load-catalog' || channel === 'skills:load-user-catalog')) return { skills: [], diagnostics }
  if (channel === 'fs:list-dir') return []
  if (channel === 'fs:check-exists') return false
  if (channel === 'fs:read-file') return { success: false, content: '', error: 'missing' }
  if (channel === 'fs:write-file') return { success: true }
  if (channel === 'config:set') return { success: true }
  throw new Error(`Unexpected IPC channel ${channel}`)
}

beforeEach(async () => {
  diagnostics = []
  invoke.mockImplementation(async (channel: string) => ipcResult(channel))
  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: { invoke, on: () => () => {}, once: () => {}, send: () => {} },
  })
  useLocaleStore.getState().setLocale('en-US')
  useProjectStore.setState({
    currentProject: {
      id: 'skill-project',
      name: 'Skill project',
      path: 'C:/novels/skill-project',
      novelConfig: {},
    } as never,
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(<SkillSettings />))
  await act(async () => {
    await vi.waitFor(() => expect(container?.querySelector('section[aria-labelledby="writing-skill-library-title"]')).not.toBeNull())
  })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  useProjectStore.setState(originalProjectState)
  useLocaleStore.setState(originalLocaleState)
  vi.restoreAllMocks()
})

describe('writing skill settings', () => {
  it('does not render github inspection or installation section', () => {
    expect(container?.querySelector('section[aria-labelledby="writing-skill-source-title"]')).toBeNull()
    expect(container?.textContent).not.toContain('GitHub')
  })

  it('localizes bundled skill metadata while preserving its Chinese copy', async () => {
    const library = container?.querySelector('section[aria-labelledby="writing-skill-library-title"]')
    expect(library?.textContent).not.toMatch(/[\u3400-\u9fff]/u)
    expect(library?.textContent).toContain('Long-form Continuity and Scene Progression')

    await act(async () => useLocaleStore.getState().setLocale('zh-CN'))

    expect(library?.textContent).toContain('长篇连续性与场景推进')
  })

  it('opens a dialog showing full instructions when a skill card is clicked', async () => {
    const card = container?.querySelector('div[role="button"]') as HTMLElement
    expect(card).not.toBeNull()
    await act(async () => card.click())
    await expect.element(page.getByRole('dialog')).toBeVisible()
    await expect.element(page.getByText('Full Instructions (Prompt Guide)')).toBeVisible()
    await act(async () => page.getByRole('button', { name: 'Close' }).first().click())
    await vi.waitFor(() => expect(page.getByRole('dialog').query()).toBeNull())
  })
})

describe('writing skill catalog diagnostics', () => {
  it('shows spec diagnostics next to the library instead of hiding the skill', async () => {
    diagnostics = [{
      code: 'invalid_metadata',
      message: 'name "SceneCraft" does not match parent directory "scene-craft"',
      path: 'C:/Users/me/.vela/skills/scene-craft/SKILL.md',
      source: 'user',
    }]
    await act(async () => root?.unmount())
    container?.remove()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root?.render(<SkillSettings />))
    await act(async () => {
      await vi.waitFor(() => expect(
        container?.textContent,
      ).toContain('does not match parent directory'))
    })

    expect(container?.textContent).toContain('Skill catalog diagnostics')
    expect(container?.textContent).toContain('C:/Users/me/.vela/skills/scene-craft/SKILL.md')
    expect(container?.textContent).not.toContain('技能目录诊断')
  })
})
