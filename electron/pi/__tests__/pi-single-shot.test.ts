import { afterEach, describe, expect, it, vi } from 'vitest'

import { resetPiInFlightForTests } from '../in-flight'
import {
  SingleShotAbortedError,
  UnexpectedSubmitToolError,
  streamSingleShot,
} from '../pi-single-shot'
import { submitDraftTool } from '../submit-tools'

vi.mock('../pi-models', () => ({
  createPiModels: vi.fn(),
}))

import { createPiModels } from '../pi-models'

const createPiModelsMock = createPiModels as ReturnType<typeof vi.fn>

afterEach(() => {
  resetPiInFlightForTests()
})

function mockStream(stream: AsyncGenerator<unknown>) {
  createPiModelsMock.mockReturnValue({
    models: { stream: vi.fn(() => stream) },
    model: {},
  })
}

describe('streamSingleShot', () => {
  it('collects validated submit tool arguments as the artifact', async () => {
    const stream = (async function* () {
      yield { type: 'text_delta', contentIndex: 0, delta: '旁白', partial: {} }
      yield {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: {
          type: 'toolCall',
          id: 'c1',
          name: 'submit_draft',
          arguments: { title: '标题', body: '正文' },
        },
        partial: {},
      }
      yield { type: 'done', reason: 'toolUse', message: {} }
    })()
    mockStream(stream)

    const result = await streamSingleShot({} as never, 'sys', 'user', submitDraftTool())

    expect(result.artifact).toEqual({ title: '标题', body: '正文' })
    expect(result.text).toBe('旁白')
    expect(result.finishReason).toBe('stop')
  })

  it('returns undefined artifact when the model emits text only', async () => {
    const stream = (async function* () {
      yield { type: 'text_delta', contentIndex: 0, delta: '纯文本', partial: {} }
      yield { type: 'done', reason: 'stop', message: {} }
    })()
    mockStream(stream)

    const result = await streamSingleShot({} as never, 'sys', 'user', submitDraftTool())

    expect(result.artifact).toBeUndefined()
    expect(result.text).toBe('纯文本')
    expect(result.finishReason).toBe('stop')
  })

  it('forwards temperature and maxTokens and maps a length done reason', async () => {
    const streamFn = vi.fn(() => (async function* () {
      yield { type: 'text_delta', contentIndex: 0, delta: '半截', partial: {} }
      yield { type: 'done', reason: 'length', message: {} }
    })())
    createPiModelsMock.mockReturnValue({
      models: { stream: streamFn },
      model: {},
    })

    const result = await streamSingleShot({} as never, 'sys', 'user', submitDraftTool(), {
      maxTokens: 64,
      temperature: 0.4,
    })

    expect(streamFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ maxTokens: 64, temperature: 0.4, toolChoice: 'any' }),
    )
    expect(result).toMatchObject({ text: '半截', finishReason: 'length' })
  })

  it('rejects a hallucinated tool name', async () => {
    const stream = (async function* () {
      yield {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { type: 'toolCall', id: 'c1', name: 'read_file', arguments: { path: 'x' } },
        partial: {},
      }
    })()
    mockStream(stream)

    await expect(streamSingleShot({} as never, 'sys', 'user', submitDraftTool()))
      .rejects.toBeInstanceOf(UnexpectedSubmitToolError)
  })

  it('rejects submit arguments that fail the schema', async () => {
    const stream = (async function* () {
      yield {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { type: 'toolCall', id: 'c1', name: 'submit_draft', arguments: { title: 1 } },
        partial: {},
      }
    })()
    mockStream(stream)

    await expect(streamSingleShot({} as never, 'sys', 'user', submitDraftTool()))
      .rejects.toThrow()
  })

  it('throws when the caller signal is already aborted', async () => {
    const signal = AbortSignal.abort()
    mockStream((async function* () {
      yield { type: 'done', reason: 'stop', message: {} }
    })())

    await expect(streamSingleShot({} as never, 'sys', 'user', submitDraftTool(), { signal }))
      .rejects.toBeInstanceOf(SingleShotAbortedError)
  })

  it('recovers artifact from text via Pi parseJsonWithRepair when model outputs JSON text without tool call', async () => {
    const stream = (async function* () {
      yield {
        type: 'text_delta',
        contentIndex: 0,
        delta: '```json\n{\n  "title": "测试标题",\n  "body": "测试正文多行\\n第二行"\n}\n```',
        partial: {},
      }
      yield { type: 'done', reason: 'stop', message: {} }
    })()
    mockStream(stream)

    const result = await streamSingleShot({} as never, 'sys', 'user', submitDraftTool())

    expect(result.artifact).toEqual({
      title: '测试标题',
      body: '测试正文多行\n第二行',
    })
    expect(result.finishReason).toBe('stop')
  })

  it('detects context overflow error via Pi isContextOverflow', async () => {
    const stream = (async function* () {
      yield {
        type: 'error',
        reason: 'error',
        error: {
          errorMessage: 'Your input exceeds the context window of this model',
        },
      }
    })()
    mockStream(stream)

    await expect(streamSingleShot({} as never, 'sys', 'user', submitDraftTool()))
      .rejects.toThrow(/Context overflow/)
  })
})
