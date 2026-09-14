import { describe, expect, it, vi } from 'vitest'

import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core'
import { createModels, Type } from '@earendil-works/pi-ai'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'

import { fauxChatModel } from './faux-model'

import { AgentSession } from '../agent-session'
import type { PiAgentEvent } from '../agent-session'
import type { AgentConversationStore } from '../agent-conversation-store'

const AddSchema = Type.Object({ a: Type.Number(), b: Type.Number() })

const addTool: AgentTool<typeof AddSchema, { sum: number }> = {
  name: 'add_numbers',
  label: 'Add Numbers',
  description: 'Add two numbers.',
  parameters: AddSchema,
  execute: async (_id, params) => ({
    content: [{ type: 'text', text: String(params.a + params.b) }],
    details: { sum: params.a + params.b },
  }),
}

function buildSession(decision: (callId: string) => boolean, events: PiAgentEvent[]) {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('add_numbers', { a: 12, b: 7 })]),
    fauxAssistantMessage('The sum is 19.'),
  ])

  const session = new AgentSession({
    model: fauxChatModel(faux),
    models,
    streamFn: models.streamSimple.bind(models),
    systemPrompt: 'You are a calculator.',
    tools: [addTool],
    confirmationToolNames: new Set(['add_numbers']),
    language: 'zh-CN',
    emit: (event) => {
      events.push(event)
      if (event.type === 'tool_call_confirm') {
        session.confirm(event.call.id, decision(event.call.id))
      }
    },
  })

  return session
}

describe('AgentSession', () => {
  it('emits the full event sequence and executes a confirmed tool', async () => {
    const events: PiAgentEvent[] = []
    const session = buildSession(() => true, events)

    await session.prompt('What is 12 + 7?')

    const types = events.map((e) => e.type)
    expect(types).toContain('text_delta')
    expect(types).toContain('tool_call_start')
    expect(types).toContain('tool_call_confirm')
    expect(types).toContain('tool_call_complete')
    expect(types).toContain('done')

    const complete = events.find((e) => e.type === 'tool_call_complete')
    expect(complete).toBeDefined()
    if (complete?.type === 'tool_call_complete') {
      expect(complete.call.status).toBe('completed')
      expect(complete.call.result).toEqual({ sum: 19 })
    }
  })

  it('blocks a declined tool and reports it as failed', async () => {
    const events: PiAgentEvent[] = []
    const session = buildSession(() => false, events)

    await session.prompt('What is 12 + 7?')

    const complete = events.find((e) => e.type === 'tool_call_complete')
    expect(complete).toBeDefined()
    if (complete?.type === 'tool_call_complete') {
      expect(complete.call.status).toBe('failed')
    }
  })

  it('restores a snapshot from the Pi session and persists what follows', async () => {
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    faux.setResponses([fauxAssistantMessage('接着聊。')])
    const appendMessages = vi.fn(async () => {})
    const store = { appendMessages } as unknown as AgentConversationStore

    const session = new AgentSession({
      model: fauxChatModel(faux),
      models,
      streamFn: models.streamSimple.bind(models),
      systemPrompt: 'You are a calculator.',
      tools: [],
      language: 'zh-CN',
      emit: () => {},
      store,
      conversationId: 'conv-1',
    })

    expect(session.restoreSnapshot({
      // 只需最小字段：这是"从存档恢复出来的消息"，不是刚生成的助手回合。
      messages: [
        { role: 'user', content: '上一轮的问题', timestamp: 1 },
        { role: 'assistant', content: [{ type: 'text', text: '上一轮的回答' }], timestamp: 2 },
      ] as unknown as AgentMessage[],
    })).toBe(true)
    expect(session.messages).toHaveLength(2)

    await session.prompt('继续')

    const persisted = appendMessages.mock.calls[0] as unknown as [string, AgentMessage[]]
    expect(persisted[0]).toBe('conv-1')
    expect(persisted[1].map(message => message.role)).toEqual(['user', 'assistant'])
    expect(JSON.stringify(persisted[1][0])).toContain('继续')
  })

  it('compacts an over-long context through Pi before the next turn', async () => {
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    // 压缩本身会打模型（摘要 + 被切开的回合前缀），先给它两次响应，再给本轮回答。
    faux.setResponses([
      fauxAssistantMessage('摘要：用户一直在核对第三章。'),
      fauxAssistantMessage('回合前缀摘要。'),
      fauxAssistantMessage('好的。'),
    ])
    const recordCompaction = vi.fn(async () => {})
    const store = { recordCompaction, appendMessages: vi.fn(async () => {}) } as unknown as AgentConversationStore
    const model = fauxChatModel(faux)
    model.contextWindow = 60

    const session = new AgentSession({
      model,
      models,
      streamFn: models.streamSimple.bind(models),
      systemPrompt: 'You are a calculator.',
      tools: [],
      language: 'zh-CN',
      emit: () => {},
      store,
      conversationId: 'conv-1',
      compactionSettings: { enabled: true, reserveTokens: 8, keepRecentTokens: 4 },
    })
    session.restoreSnapshot({
      messages: Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: index % 2 === 0
          ? `第 ${index} 轮的问题，内容足够长以便触发压缩判断。`
          : [{ type: 'text' as const, text: `第 ${index} 轮的回答，同样写得长一些。` }],
        timestamp: index,
      })) as unknown as AgentMessage[],
    })

    await session.prompt('继续')

    expect(session.messages[0]).toMatchObject({ role: 'compactionSummary' })
    expect(JSON.stringify(session.messages[0])).toContain('摘要：用户一直在核对第三章。')
    expect(session.messages.length).toBeLessThan(13)
    expect(recordCompaction).toHaveBeenCalledWith('conv-1', expect.objectContaining({
      summary: expect.stringContaining('摘要：用户一直在核对第三章。'),
      tokensBefore: expect.any(Number),
      retainedTail: expect.any(Array),
    }))
  })

  it('restores prior user/assistant turns onto a new session', () => {
    const session = buildSession(() => true, [])
    session.restoreHistory([
      { role: 'user', content: '上一本的问题' },
      { role: 'assistant', content: '上一本的回答' },
    ])
    expect(session.messages).toHaveLength(2)
    expect(session.messages[0]).toMatchObject({ role: 'user', content: '上一本的问题' })
  })
})
