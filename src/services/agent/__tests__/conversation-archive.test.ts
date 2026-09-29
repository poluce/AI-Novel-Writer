import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAgentStore } from '../../../stores/agent-store'
import {
  flushAgentConversations,
  loadProjectAgentConversations,
} from '../conversation-archive'

const invoke = vi.hoisted(() => vi.fn())

vi.mock('../../ipc-client', () => ({
  ipc: {
    invoke,
    invokeWithProjectSession: vi.fn(),
    on: vi.fn(() => () => {}),
  },
}))

const sessionA = {
  projectId: 'a',
  projectPath: 'C:\\novels\\A',
}

describe('single source of truth conversation archive', () => {
  beforeEach(() => {
    invoke.mockReset()
    useAgentStore.getState().beginProjectLoad()
  })

  afterEach(() => {
    useAgentStore.getState().beginProjectLoad()
  })

  it('loads project conversations directly from native main-process store', async () => {
    invoke.mockResolvedValueOnce({
      success: true,
      activeConversationId: 'p-1',
      conversations: [
        {
          id: 'p-1',
          title: '项目会话 1',
          createdAt: 1000,
          updatedAt: 2000,
          mode: 'planning',
          modelId: null,
          messages: [{ id: 'm1', role: 'user', content: '测试消息', createdAt: 1000 }],
        },
      ],
    })

    const archive = await loadProjectAgentConversations(sessionA)
    expect(invoke).toHaveBeenCalledWith('agent:list-conversations')
    expect(archive.activeConversationId).toBe('p-1')
    expect(archive.conversations).toHaveLength(1)
    expect(archive.conversations[0].title).toBe('项目会话 1')
  })

  it('flushAgentConversations resolves immediately as a safe no-op without writing files', async () => {
    await expect(flushAgentConversations(sessionA)).resolves.toBeUndefined()
    expect(invoke).not.toHaveBeenCalledWith('agent:save-global-conversations', expect.anything())
  })
})
