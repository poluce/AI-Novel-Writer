import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

import {
  createRendererActionDispatcher,
  RENDERER_ACTION_RECEIPT_TIMEOUT_MS,
} from '../renderer-action-dispatch'

const messages = {
  noWindow: 'no-window',
  timeout: 'timeout',
  aborted: 'aborted',
}

function fakeWindow() {
  const send = vi.fn()
  const win = { webContents: { send } } as unknown as BrowserWindow
  return { win, send }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createRendererActionDispatcher', () => {
  it('sends non-blocking actions without waiting for a receipt', () => {
    const { win, send } = fakeWindow()
    const dispatcher = createRendererActionDispatcher({
      mainWindow: () => win,
      messages: () => messages,
    })

    const result = dispatcher.rendererAction({ type: 'refresh_project_config' })

    expect(result).toBeUndefined()
    expect(send).toHaveBeenCalledWith('agent:renderer-action', {
      action: { type: 'refresh_project_config' },
    })
  })

  it('waits for the renderer receipt before resolving replace_draft_excerpt', async () => {
    const { win, send } = fakeWindow()
    const dispatcher = createRendererActionDispatcher({
      mainWindow: () => win,
      messages: () => messages,
    })
    const pending = dispatcher.rendererAction({
      type: 'replace_draft_excerpt',
      chapterNumber: 1,
      oldText: '他走了',
      newText: '他离开了',
    })
    const payload = send.mock.calls[0]?.[1] as { requestId: string }
    dispatcher.complete(payload.requestId, { ok: true, summary: 'replaced' })
    await expect(pending).resolves.toEqual({ ok: true, summary: 'replaced' })
  })

  it('waits for the renderer receipt before resolving replace_draft_excerpt', async () => {
    const { win, send } = fakeWindow()
    const dispatcher = createRendererActionDispatcher({
      mainWindow: () => win,
      messages: () => messages,
    })

    const pending = dispatcher.rendererAction({
      type: 'replace_draft_excerpt',
      chapterNumber: 1,
      oldText: 'aaa',
      newText: 'bbb',
    })
    expect(pending).toBeInstanceOf(Promise)
    const payload = send.mock.calls[0]?.[1] as { requestId: string }
    expect(payload.requestId).toEqual(expect.any(String))

    expect(dispatcher.complete(payload.requestId, {
      ok: true,
      summary: 'replaced',
    })).toBe(true)
    await expect(pending).resolves.toEqual({ ok: true, summary: 'replaced' })
  })

  it('returns the renderer error instead of inventing success', async () => {
    const { win, send } = fakeWindow()
    const dispatcher = createRendererActionDispatcher({
      mainWindow: () => win,
      messages: () => messages,
    })

    const pending = dispatcher.rendererAction({
      type: 'replace_draft_excerpt',
      chapterNumber: 1,
      oldText: 'aaa',
      newText: 'bbb',
    })
    const payload = send.mock.calls[0]?.[1] as { requestId: string }
    dispatcher.complete(payload.requestId, {
      ok: false,
      error: '需要草稿快照',
    })
    await expect(pending).resolves.toEqual({ ok: false, error: '需要草稿快照' })
  })

  it('fails closed when no window is available', async () => {
    const dispatcher = createRendererActionDispatcher({
      mainWindow: () => null,
      messages: () => messages,
    })
    await expect(dispatcher.rendererAction({
      type: 'replace_draft_excerpt',
      chapterNumber: 1,
      oldText: 'aaa',
      newText: 'bbb',
    })).resolves.toEqual({ ok: false, error: 'no-window' })
  })

  it('times out if the renderer never confirms registration', async () => {
    vi.useFakeTimers()
    const { win } = fakeWindow()
    const dispatcher = createRendererActionDispatcher({
      mainWindow: () => win,
      messages: () => messages,
      timeoutMs: RENDERER_ACTION_RECEIPT_TIMEOUT_MS,
    })
    const pending = dispatcher.rendererAction({
      type: 'replace_draft_excerpt',
      chapterNumber: 1,
      oldText: 'aaa',
      newText: 'bbb',
    })
    await vi.advanceTimersByTimeAsync(RENDERER_ACTION_RECEIPT_TIMEOUT_MS)
    await expect(pending).resolves.toEqual({ ok: false, error: 'timeout' })
  })

  it('aborts in-flight blocking waits', async () => {
    const { win } = fakeWindow()
    const dispatcher = createRendererActionDispatcher({
      mainWindow: () => win,
      messages: () => messages,
    })
    const pending = dispatcher.rendererAction({
      type: 'replace_draft_excerpt',
      chapterNumber: 2,
      oldText: 'aaa',
      newText: 'bbb',
    })
    dispatcher.abortAll()
    await expect(pending).resolves.toEqual({ ok: false, error: 'aborted' })
  })
})
