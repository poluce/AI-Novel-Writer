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

const OUTLINE = [
  '# 情节大纲',
  '',
  '全书围绕灵脉异变展开，主角从铁砧镇一路追查到终局。',
  '',
  '## 第一卷',
  '',
  '第1–20章：核对记录',
  '林舟逐条核对旧案记录，确认灵脉异变的第一个信号。',
  '',
  '第21章：破门',
  '宗门废墟之下，林舟第一次触碰旧铁锤里的传承。',
  '',
  '## 第二卷',
  '',
  '第22–100章：反噬',
  '记忆损耗的代价持续推进，并在终局兑现。',
  '',
  '> 本大纲已覆盖至第 20 章（全书 100 章），其余章节将在后续批次继续生成。',
  '',
].join('\n')

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
let coreUpdates: Array<Record<string, unknown>>
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
  coreUpdates = []
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
      invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
        if (channel === 'db:project-core-get') return core
        if (channel === 'db:character-roster-read') return roster
        if (channel === 'db:project-core-update') {
          const payload = args[0] as Record<string, unknown>
          coreUpdates.push(payload)
          // 保存后 loadStatus 会重新读库，这里让 mock 返回已保存的内容。
          core = { ...core, ...payload }
          return { success: true }
        }
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

  it('renders the whole outline as one document and drives it from the ten-chapter table of contents', async () => {
    core = { synopsis: OUTLINE, totalChapters: 100, writingLanguage: 'zh-CN' }
    await renderEditor()

    // 左侧是每 10 章折叠的目录。
    const toc = () => container.querySelector('[data-testid="synopsis-toc"]')?.textContent ?? ''
    expect(toc()).toContain('总览')
    expect(toc()).toContain('第1–10章')
    expect(toc()).toContain('第21–30章')
    expect(toc()).not.toContain('第22–100章')

    // 右侧是整份拼接好的大纲，所有段落都在同一篇文档里。
    const doc = container.querySelector('[data-testid="synopsis-document"]') as HTMLElement
    expect(doc.textContent).toContain('第1–20章')
    expect(doc.textContent).toContain('第21章')
    expect(doc.textContent).toContain('第22–100章')
    expect(doc.textContent).toContain('本大纲已覆盖至第 20 章')
    expect(doc.querySelectorAll('[data-node-id]')).toHaveLength(4)

    // 展开分组并点击目录项 → 该项成为当前段落（右侧文档随之滚动定位）。
    await act(async () => page.getByText('第21–30章', { exact: true }).click())
    expect(toc()).toContain('第22–100章')
    await act(async () => page.getByText('第21章', { exact: true }).click())
    expect(container.querySelector('[aria-current="true"]')?.textContent).toContain('第21章')

    // 再次点击分组标题可折叠回去。
    await act(async () => page.getByText('第21–30章', { exact: true }).click())
    expect(toc()).not.toContain('第22–100章')
  })

  it('saves an edited section back into the whole outline without touching other ranges', async () => {
    core = { synopsis: OUTLINE, totalChapters: 100, writingLanguage: 'zh-CN' }
    container.style.height = '400px'
    await renderEditor()

    await act(async () => page.getByText('第21–30章', { exact: true }).click())
    const editor = page.getByRole('textbox', { name: '第21章的大纲正文' })
    await act(async () => editor.fill('林舟破门而入，却发现传承早已被人取走。'))

    expect(container.textContent).toContain('未保存 1 段')
    await act(async () => page.getByRole('button', { name: '保存「第21章」' }).click())

    await vi.waitFor(() => expect(coreUpdates).toHaveLength(1))
    expect(coreUpdates[0].synopsis).toBe(OUTLINE.replace(
      '宗门废墟之下，林舟第一次触碰旧铁锤里的传承。',
      '林舟破门而入，却发现传承早已被人取走。',
    ))
    await vi.waitFor(() => expect(container.textContent).not.toContain('未保存'))
    // 其余章节区间原样保留。
    expect(container.textContent).toContain('第22–100章')
  })

  it('saves several edited sections in one write without shifting earlier offsets', async () => {
    core = { synopsis: OUTLINE, totalChapters: 100, writingLanguage: 'zh-CN' }
    container.style.height = '500px'
    await renderEditor()

    await act(async () => page.getByRole('textbox', { name: '第1–20章的大纲正文' })
      .fill('林舟核对到第三条线索时，发现封锁令的签发时间被人改过。'))
    await act(async () => page.getByRole('textbox', { name: '第22–100章的大纲正文' })
      .fill('记忆代价在终局一次性兑现，林舟失去了自己的名字。'))
    expect(container.textContent).toContain('未保存 2 段')

    await act(async () => page.getByRole('button', { name: '保存全部' }).click())

    await vi.waitFor(() => expect(coreUpdates).toHaveLength(1))
    const saved = String(coreUpdates[0].synopsis)
    expect(saved).toBe(OUTLINE
      .replace(
        '林舟逐条核对旧案记录，确认灵脉异变的第一个信号。',
        '林舟核对到第三条线索时，发现封锁令的签发时间被人改过。',
      )
      .replace(
        '记忆损耗的代价持续推进，并在终局兑现。',
        '记忆代价在终局一次性兑现，林舟失去了自己的名字。',
      ))
  })

  it('falls back to one whole-document section when the outline has no chapter labels', async () => {
    core = {
      synopsis: '# 情节大纲\n\n第一幕：主角失去家园。\n\n第二幕：主角夺回主动权。',
      totalChapters: 100,
      writingLanguage: 'zh-CN',
    }
    await renderEditor()

    await expect.element(page.getByRole('heading', { name: '全文' })).toBeVisible()
    await expect.element(page.getByRole('textbox', { name: '全文的大纲正文' }))
      .toHaveValue('第一幕：主角失去家园。\n\n第二幕：主角夺回主动权。')
  })
})
