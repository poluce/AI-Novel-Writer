import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAgentStore } from '../../../stores/agent-store'
import {
  flushAgentConversations,
  loadProjectAgentConversations,
} from '../conversation-archive'

const invokeWithProjectSession = vi.hoisted(() => vi.fn())

vi.mock('../../ipc-client', () => ({
  ipc: {
    invoke: vi.fn(),
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
