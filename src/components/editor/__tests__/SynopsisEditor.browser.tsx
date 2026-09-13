import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { synopsisFactsFingerprint } from '../../../services/workflows/commands/architecture.command'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import SynopsisEditor from '../SynopsisEditor'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT_PATH = 'C:\\novels\\synopsis-editor'
const PROJECT_SESSION = {
  projectId: 'synopsis-editor',
  leaseId: 'lease-synopsis-editor',
  projectPath: PROJECT_PATH,
}

const launchCreativeWorkflow = vi.hoisted(() => vi.fn())

vi.mock('../../../services/workflows/creative-workflow-launcher', () => ({
  launchCreativeWorkflow,
}))

const project = {
  id: PROJECT_SESSION.projectId,
  sessionLease: PROJECT_SESSION.leaseId,
  name: 'Synopsis editor',
  path: PROJECT_PATH,
  novelConfig: { totalChapters: 100, writingLanguage: 'zh-CN' },
}

let root: Root
let container: HTMLDivElement
let core: Record<string, unknown>
let roster: Record<string, unknown>
let checkpoint: Record<string, unknown> | undefined
const originalLocale = useLocaleStore.getState()
const originalWorkflow = useWorkflowStore.getState()

beforeEach(() => {
  launchCreativeWorkflow.mockReset()
  launchCreativeWorkflow.mockResolvedValue({
    accepted: true,
    workflow: 'generate_architecture',
    projectPath: PROJECT_PATH,
    projectSession: PROJECT_SESSION,
    runId: 'synopsis-run',
    status: 'running',
  })
  core = { synopsis: '', totalChapters: 100, writingLanguage: 'zh-CN' }
  roster = { status: 'ready' }
  checkpoint = undefined
  useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
  useProjectStore.setState({ currentProject: project as never })
  useWorkflowStore.setState({
    activeRuns: [], history: [], globalLogs: [], waitingRuns: {}, currentRun: null,
    waitingForConfirm: false, waitingAfterStepIndex: -1,
  })
  setActiveProjectSessionContext(PROJECT_SESSION)
  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: {
      invoke: vi.fn(async (channel: string) => {
        if (channel === 'db:project-core-get') return core
        if (channel === 'db:character-roster-read') return roster
        if (channel === 'fs:read-json') {
          return checkpoint ? { success: true, data: checkpoint } : { success: false, error: 'not found' }
        }
        throw new Error(`Unexpected IPC channel: ${channel}`)
      }),
      on: vi.fn(() => () => {}),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(() => 0),
    },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'velaAPI')
  setActiveProjectSessionContext(null)
  useLocaleStore.setState(originalLocale)
  useProjectStore.setState({ currentProject: null })
  useWorkflowStore.setState(originalWorkflow)
})

async function renderEditor() {
  await act(async () => root.render(<SynopsisEditor projectKey={PROJECT_PATH} />))
}

describe('SynopsisEditor', () => {
  it('defaults a large book to the first 20 chapters and launches that batch', async () => {
    await renderEditor()

    await expect.element(page.getByRole('spinbutton', { name: '本次生成范围的起始章' })).toHaveValue(1)
    await expect.element(page.getByRole('spinbutton', { name: '本次生成范围的结束章' })).toHaveValue(20)

    await act(async () => page.getByRole('button', { name: /AI 生成大纲/ }).click())

    await vi.waitFor(() => expect(launchCreativeWorkflow).toHaveBeenCalledTimes(1))
    expect(launchCreativeWorkflow.mock.calls[0]?.[0]).toMatchObject({
      workflow: 'generate_architecture',
      selectedSteps: ['synopsis'],
      synopsisRange: { from: 1, to: 20 },
    })
  })

  it('generates the whole book when both range bounds are cleared', async () => {
    await renderEditor()

    await act(async () => page.getByRole('spinbutton', { name: '本次生成范围的起始章' }).fill(''))
    await act(async () => page.getByRole('spinbutton', { name: '本次生成范围的结束章' }).fill(''))
    await act(async () => page.getByRole('button', { name: /AI 生成大纲/ }).click())

    await vi.waitFor(() => expect(launchCreativeWorkflow).toHaveBeenCalledTimes(1))
    const intent = launchCreativeWorkflow.mock.calls[0]?.[0] as Record<string, unknown>
    expect(intent.workflow).toBe('generate_architecture')
    expect(intent.selectedSteps).toEqual(['synopsis'])
    expect(intent.synopsisRange).toBeUndefined()
  })

  it('offers the continuation batch for a partially covered outline and continues from the next chapter', async () => {
    const body = 'Chapters 1-20: the crew follows each clue and preserves cause and effect. '.repeat(3).trim()
    const dbSynopsis = `# Plot Outline\n\n${body}\n\n> This outline covers chapters 1-20 of 100; the remaining chapters will be generated in later batches.`
    core = { synopsis: dbSynopsis, totalChapters: 100, writingLanguage: 'en-US' }
    checkpoint = {
      synopsis_result: body,
      synopsis_incomplete: false,
      synopsis_covered_to: 20,
      synopsis_range: { from: 1, to: 20 },
      synopsis_facts_fingerprint: 'stored-inputs',
      synopsis_db_hash: synopsisFactsFingerprint([dbSynopsis]),
    }
    await renderEditor()

    const continueButton = page.getByRole('button', { name: /续批（第 21 章起）/ })
    await expect.element(continueButton).toBeVisible()
    await act(async () => continueButton.click())

    await vi.waitFor(() => expect(launchCreativeWorkflow).toHaveBeenCalledTimes(1))
    expect(launchCreativeWorkflow.mock.calls[0]?.[0]).toMatchObject({
      workflow: 'generate_architecture',
      selectedSteps: ['synopsis'],
      synopsisRange: { from: 21, to: 40 },
    })
  })

  it('rejects an out-of-range batch instead of launching generation', async () => {
    await renderEditor()

    await act(async () => page.getByRole('spinbutton', { name: '本次生成范围的结束章' }).fill('500'))
    await act(async () => page.getByRole('button', { name: /AI 生成大纲/ }).click())

    await vi.waitFor(() => expect(launchCreativeWorkflow).not.toHaveBeenCalled())
  })

  it('warns about missing architecture inputs until every authoritative block exists', async () => {
    core = {
      synopsis: '',
      premise: '',
      worldbuilding: '',
      totalChapters: 100,
      writingLanguage: 'zh-CN',
    }
    roster = { status: 'legacy_repair_required' }
    await renderEditor()

    await expect.element(page.getByText(/建议先在「故事架构」完成：故事前提、角色图谱、世界观/)).toBeVisible()

    core = {
      synopsis: '',
      premise: '前提'.repeat(40),
      worldbuilding: '世界观'.repeat(40),
      totalChapters: 100,
      writingLanguage: 'zh-CN',
    }
    roster = { status: 'ready' }
    await act(async () => page.getByRole('button', { name: '刷新状态' }).click())

    await vi.waitFor(() => {
      expect(container.textContent).not.toContain('建议先在「故事架构」完成')
    })
  })
})
