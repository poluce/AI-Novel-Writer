import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useEditorStore } from '../../../stores/editor-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { applyDraftExcerptReplace } from '../apply-draft-excerpt'

const invokeWithProjectSession = vi.hoisted(() => vi.fn())

vi.mock('../../ipc-client', () => ({
  ipc: {
    invoke: vi.fn(),
    invokeWithProjectSession,
    on: vi.fn(() => () => {}),
  },
}))

const PROJECT_PATH = 'C:\\novels\\excerpt'
const SESSION = {
  projectId: 'excerpt',
  leaseId: 'lease-excerpt',
  projectPath: PROJECT_PATH,
}

describe('applyDraftExcerptReplace', () => {
  beforeEach(() => {
    invokeWithProjectSession.mockReset()
    useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
    useProjectStore.setState({
      currentProject: {
        id: SESSION.projectId,
        sessionLease: SESSION.leaseId,
        name: 'Excerpt',
        path: PROJECT_PATH,
        novelConfig: {},
      } as never,
    })
    useEditorStore.setState({
      tabs: [{
        id: 'tab-1',
        name: '第1章',
        type: 'chapter',
        filePath: 'vela://draft/7',
        content: '顾舟停在潮门口。风很大。',
        draftId: 7,
        chapterNumber: 1,
        draftStatus: 'draft',
        projectKey: PROJECT_PATH,
        dirty: false,
        contentRevision: 1,
      }],
      activeTabId: 'tab-1',
      draftLedgers: {},
    })
  })

  it('replaces a unique excerpt in the open draft and saves it', async () => {
    invokeWithProjectSession.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:draft-update-content') return { success: true }
      throw new Error(channel)
    })
    const result = await applyDraftExcerptReplace({
      chapterNumber: 1,
      oldText: '顾舟停在潮门口。',
      newText: '顾舟在潮门口停了一停。',
      draftId: 7,
    })
    expect(result).toMatchObject({ ok: true })
    expect(useEditorStore.getState().tabs[0]?.content).toBe('顾舟在潮门口停了一停。风很大。')
    expect(useEditorStore.getState().tabs[0]?.dirty).toBe(false)
    expect(invokeWithProjectSession).toHaveBeenCalledWith(
      SESSION,
      'db:draft-update-content',
      7,
      '顾舟在潮门口停了一停。风很大。',
      expect.any(Number),
      PROJECT_PATH,
    )
  })

  it('refuses an ambiguous excerpt', async () => {
    useEditorStore.setState(state => ({
      tabs: state.tabs.map(tab => ({ ...tab, content: '他走了。他走了。' })),
    }))
    const result = await applyDraftExcerptReplace({
      chapterNumber: 1,
      oldText: '他走了。',
      newText: '他离开了。',
      draftId: 7,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('不止一次')
    expect(invokeWithProjectSession).not.toHaveBeenCalled()
  })
})
