import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAgentStore } from '../../../stores/agent-store'
import {
  flushAgentConversations,
  loadGlobalAgentConversations,
  loadProjectAgentConversations,
  saveGlobalAgentConversations,
  snapshotArchiveForScope,
} from '../conversation-archive'

const invokeWithProjectSession = vi.hoisted(() => vi.fn())
const invoke = vi.hoisted(() => vi.fn())

vi.mock('../../ipc-client', () => ({
  ipc: {
    invoke,
    invokeWithProjectSession,
    on: vi.fn(() => () => {}),
  },
}))

const sessionA = {
  projectId: 'a',
  leaseId: 'lease-a',
  projectPath: 'C:\\novels\\A',
}

const sessionB = {
  projectId: 'b',
  leaseId: 'lease-b',
  projectPath: 'C:\\novels\\B',
}

describe('project agent conversation archive', () => {
  beforeEach(() => {
    invokeWithProjectSession.mockReset()
    invoke.mockReset()
    useAgentStore.getState().beginProjectLoad()
  })

  afterEach(() => {
    useAgentStore.getState().beginProjectLoad()
  })

  it('loads an empty archive when the project file is missing', async () => {
    invokeWithProjectSession.mockImplementation(async (_session, channel: string) => {
      if (channel === 'fs:check-exists') return false
      throw new Error(channel)
    })
    await expect(loadProjectAgentConversations(sessionA)).resolves.toMatchObject({
      conversations: [],
      activeConversationId: null,
    })
  })

  it('does not write book A chats into book B', async () => {
    useAgentStore.getState().hydrateFromArchive(sessionA, {
      version: 1,
      activeConversationId: 'c-a',
      conversations: [{
        id: 'c-a',
        title: '书A',
        createdAt: 1,
        updatedAt: 1,
        mode: 'planning',
        modelId: null,
        messages: [{ id: 'm1', role: 'user', content: '只属于A', createdAt: 1 }],
      }],
    })
    invokeWithProjectSession.mockResolvedValue({ success: true, commitState: 'committed' })
    await flushAgentConversations(sessionB)
    expect(invokeWithProjectSession).not.toHaveBeenCalled()

    await flushAgentConversations(sessionA)
    const write = invokeWithProjectSession.mock.calls.find(call => call[1] === 'fs:write-file')
    expect(String(write?.[2]).replaceAll('\\', '/')).toBe('C:/novels/A/.vela/agent-conversations.json')
    expect(String(write?.[3])).toContain('只属于A')
    expect(String(write?.[3])).not.toContain('书B')
  })

  it('keeps the app assistant archive in the app data directory, not in any project', async () => {
    useAgentStore.getState().setScope('global')
    useAgentStore.getState().createConversation()
    await useAgentStore.getState().sendMessage('没打开项目时的提问')
    invoke.mockResolvedValue({ success: true })

    const archive = snapshotArchiveForScope('global')
    expect(archive.conversations).toHaveLength(1)
    await saveGlobalAgentConversations(archive)

    const write = invoke.mock.calls.find(([channel]) => channel === 'agent:save-global-conversations')
    expect(write?.[1]).toContain('没打开项目时的提问')
    expect(invoke).not.toHaveBeenCalledWith('fs:write-file', expect.anything(), expect.anything(), expect.anything())
  })

  it('loads the app assistant archive through the main process', async () => {
    invoke.mockResolvedValue({
      exists: true,
      content: JSON.stringify({
        version: 1,
        activeConversationId: 'g-1',
        conversations: [{
          id: 'g-1',
          title: '界面助手',
          createdAt: 1,
          updatedAt: 1,
          mode: 'planning',
          modelId: null,
          messages: [{ id: 'm1', role: 'user', content: '全局会话', createdAt: 1 }],
        }],
      }),
    })
    await expect(loadGlobalAgentConversations()).resolves.toMatchObject({
      activeConversationId: 'g-1',
      conversations: [{ title: '界面助手' }],
    })
    expect(invoke).toHaveBeenCalledWith('agent:load-global-conversations')
  })

  it('never writes app assistant conversations into the project archive', async () => {
    useAgentStore.getState().setScope('global')
    useAgentStore.getState().createConversation()
    await useAgentStore.getState().sendMessage('全局提问')
    invoke.mockResolvedValue({ success: true })
    invokeWithProjectSession.mockResolvedValue({ success: true, commitState: 'committed' })

    // 用与上一个用例不同的内容，避免命中"内容没变就不写"的去重。
    useAgentStore.getState().hydrateFromArchive(sessionA, {
      version: 1,
      activeConversationId: null,
      conversations: [{
        id: 'c-a-scope',
        title: '书A 作用域用例',
        createdAt: 2,
        updatedAt: 2,
        mode: 'planning',
        modelId: null,
        messages: [{ id: 'm1', role: 'user', content: '只属于A', createdAt: 2 }],
      }],
    })
    await flushAgentConversations(sessionA)

    const projectWrite = invokeWithProjectSession.mock.calls.find(call => call[1] === 'fs:write-file')
    expect(String(projectWrite?.[3])).toContain('只属于A')
    expect(String(projectWrite?.[3])).not.toContain('全局提问')
    const globalWrite = invoke.mock.calls.find(([channel]) => channel === 'agent:save-global-conversations')
    expect(String(globalWrite?.[1])).toContain('全局提问')
    expect(String(globalWrite?.[1])).not.toContain('只属于A')
  })

  it('hydrates the UI from the current project archive', () => {
    useAgentStore.getState().hydrateFromArchive(sessionB, {
      version: 1,
      activeConversationId: 'c-b',
      conversations: [{
        id: 'c-b',
        title: '书B',
        createdAt: 1,
        updatedAt: 1,
        mode: 'fast',
        modelId: null,
        messages: [{ id: 'm2', role: 'user', content: '只属于B', createdAt: 1 }],
      }],
    })
    expect(useAgentStore.getState().getActiveConversation()?.title).toBe('书B')
    expect(useAgentStore.getState().dataProjectSession).toEqual(sessionB)
  })
})
