import { describe, expect, it } from 'vitest'

import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createModels, Type } from '@earendil-works/pi-ai'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'

import { createPiAgent } from '../pi-agent'
import type { PiToolCallInfo } from '../pi-agent'

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

describe('createPiAgent', () => {
  it('streams text, executes a tool, and reports done via the callback contract', async () => {
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('add_numbers', { a: 12, b: 7 })]),
      fauxAssistantMessage('The sum is 19.'),
    ])

    const text: string[] = []
    const toolStarts: PiToolCallInfo[] = []
    const toolCompletes: PiToolCallInfo[] = []
    let doneText = ''

    const handle = createPiAgent({
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      systemPrompt: 'You are a calculator.',
      tools: [addTool],
      callbacks: {
        onTextChunk: (chunk) => { text.push(chunk) },
        onToolCallStart: (call) => { toolStarts.push(call) },
        onToolCallConfirmRequired: async () => true,
        onToolCallComplete: (call) => { toolCompletes.push(call) },
        onDone: (fullText) => { doneText = fullText },
        onError: () => {},
      },
    })

    await handle.prompt('What is 12 + 7?')

    expect(text.join('')).toBe('The sum is 19.')
    expect(toolStarts).toHaveLength(1)
    expect(toolStarts[0].toolName).toBe('add_numbers')
    expect(toolCompletes).toHaveLength(1)
    expect(toolCompletes[0].status).toBe('completed')
    expect(toolCompletes[0].result).toEqual({ sum: 19 })
    expect(doneText).toBe('The sum is 19.')
  })

  it('runs parallel-capable tools concurrently in one assistant turn', async () => {
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
    const started: number[] = []
    const slowTool = (name: string): AgentTool<typeof AddSchema, { name: string }> => ({
      name,
      label: name,
      description: name,
      parameters: AddSchema,
      execute: async () => {
        started.push(Date.now())
        await wait(80)
        return { content: [{ type: 'text', text: name }], details: { name } }
      },
    })
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('slow_a', { a: 1, b: 1 }),
        fauxToolCall('slow_b', { a: 1, b: 1 }),
      ]),
      fauxAssistantMessage('ok'),
    ])
    const handle = createPiAgent({
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      systemPrompt: 'You are a calculator.',
      tools: [slowTool('slow_a'), slowTool('slow_b')],
      callbacks: {
        onTextChunk: () => {},
        onToolCallStart: () => {},
        onToolCallConfirmRequired: async () => true,
        onToolCallComplete: () => {},
        onDone: () => {},
        onError: () => {},
      },
    })
    const t0 = Date.now()
    await handle.prompt('run both')
    expect(started).toHaveLength(2)
    expect(Math.abs(started[1]! - started[0]!)).toBeLessThan(50)
    expect(Date.now() - t0).toBeLessThan(160)
  })

  it('surfaces encoded stream failures instead of an empty successful turn', async () => {
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    faux.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'upstream 401' }),
    ])
    let error = ''
    let done = false
    const handle = createPiAgent({
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      systemPrompt: 'x',
      tools: [],
      callbacks: {
        onTextChunk: () => {},
        onToolCallStart: () => {},
        onToolCallConfirmRequired: async () => true,
        onToolCallComplete: () => {},
        onDone: () => { done = true },
        onError: (message) => { error = message },
      },
    })
    await handle.prompt('hi')
    expect(done).toBe(false)
    expect(error).toBe('upstream 401')
  })

  it('blocks a confirmed write tool when the user declines', async () => {
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('add_numbers', { a: 1, b: 2 })]),
      fauxAssistantMessage('ok'),
    ])

    const toolCompletes: PiToolCallInfo[] = []
    let confirmations = 0

    const handle = createPiAgent({
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      systemPrompt: 'Calculator.',
      tools: [addTool],
      confirmationToolNames: new Set(['add_numbers']),
      callbacks: {
        onTextChunk: () => {},
        onToolCallStart: () => {},
        onToolCallConfirmRequired: async () => { confirmations++; return false },
        onToolCallComplete: (call) => { toolCompletes.push(call) },
        onDone: () => {},
        onError: () => {},
      },
    })

    await handle.prompt('add 1 and 2')

    expect(confirmations).toBe(1)
    expect(toolCompletes).toHaveLength(1)
    expect(toolCompletes[0].status).toBe('failed')
  })

  it('requires confirmation for mcp__ tools even when they are not listed', async () => {
    const mcpTool: AgentTool<typeof AddSchema, { sum: number }> = {
      ...addTool,
      name: 'mcp__docs__search',
    }
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('mcp__docs__search', { a: 1, b: 2 })]),
      fauxAssistantMessage('ok'),
    ])
    let confirmations = 0
    const handle = createPiAgent({
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      systemPrompt: 'Docs.',
      tools: [mcpTool],
      callbacks: {
        onTextChunk: () => {},
        onToolCallStart: () => {},
        onToolCallConfirmRequired: async () => { confirmations++; return false },
        onToolCallComplete: () => {},
        onDone: () => {},
        onError: () => {},
      },
    })
    await handle.prompt('search')
    expect(confirmations).toBe(1)
  })

  it('stops after an unknown write commit instead of letting the model retry', async () => {
    const WriteSchema = Type.Object({ file_path: Type.String(), content: Type.String() })
    const writeTool: AgentTool<typeof WriteSchema, { commitState: 'unknown' }> = {
      name: 'write_file',
      label: 'Write File',
      description: 'Write a file.',
      parameters: WriteSchema,
      execute: async () => ({
        content: [{ type: 'text', text: '写入结果未知' }],
        details: { commitState: 'unknown' },
      }),
    }

    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write_file', { file_path: 'notes.md', content: 'x' })]),
      fauxAssistantMessage('I will retry the write now.'),
    ])

    let doneText = ''
    const handle = createPiAgent({
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      systemPrompt: 'Writer.',
      tools: [writeTool],
      callbacks: {
        onTextChunk: () => {},
        onToolCallStart: () => {},
        onToolCallConfirmRequired: async () => true,
        onToolCallComplete: () => {},
        onDone: (fullText) => { doneText = fullText },
        onError: () => {},
      },
    })

    await handle.prompt('write notes')

    expect(doneText).not.toContain('I will retry the write now.')
  })
})
