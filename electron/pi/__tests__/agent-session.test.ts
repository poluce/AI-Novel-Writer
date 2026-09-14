import { describe, expect, it } from 'vitest'

import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createModels, Type } from '@earendil-works/pi-ai'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'

import { fauxChatModel } from './faux-model'

import { AgentSession } from '../agent-session'
import type { PiAgentEvent } from '../agent-session'

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
