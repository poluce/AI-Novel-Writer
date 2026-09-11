import { describe, expect, it, vi } from 'vitest'

import { streamSingleShot } from '../pi-single-shot'

vi.mock('../pi-models', () => ({
  createPiModels: vi.fn(),
}))

import { createPiModels } from '../pi-models'

const createPiModelsMock = createPiModels as ReturnType<typeof vi.fn>

describe('streamSingleShot', () => {
  it('collects the submit tool arguments as the artifact', async () => {
    const stream = (async function* () {
      yield { type: 'text_delta', contentIndex: 0, delta: '正文', partial: {} }
      yield {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { type: 'toolCall', id: 'c1', name: 'submit_draft', arguments: { title: '标题', body: '正文' } },
        partial: {},
      }
      yield { type: 'done', reason: 'toolUse', message: {} }
    })()
    createPiModelsMock.mockReturnValue({
      models: { stream: vi.fn(() => stream) },
      model: {},
    })

    const result = await streamSingleShot({} as never, 'sys', 'user', {} as never)

    expect(result.artifact).toEqual({ title: '标题', body: '正文' })
    expect(result.text).toBe('正文')
  })

  it('returns undefined artifact when the model emits text only', async () => {
    const stream = (async function* () {
      yield { type: 'text_delta', contentIndex: 0, delta: '纯文本', partial: {} }
      yield { type: 'done', reason: 'stop', message: {} }
    })()
    createPiModelsMock.mockReturnValue({
      models: { stream: vi.fn(() => stream) },
      model: {},
    })

    const result = await streamSingleShot({} as never, 'sys', 'user', {} as never)

    expect(result.artifact).toBeUndefined()
    expect(result.text).toBe('纯文本')
  })
})
