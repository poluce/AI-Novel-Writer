import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'

import type {
  RendererAction,
  RendererActionResult,
} from '../../src/shared/agent-events'

export const RENDERER_ACTION_RECEIPT_TIMEOUT_MS = 30_000

export interface RendererActionDispatchMessages {
  noWindow: string
  timeout: string
  aborted: string
}

export interface RendererActionDispatcher {
  rendererAction: (action: RendererAction) => void | Promise<RendererActionResult>
  complete: (requestId: string, result: RendererActionResult) => boolean
  abortAll: () => void
}

function isBlockingAction(action: RendererAction): boolean {
  return action.type === 'replace_draft_excerpt'
}

/**
 * Fire-and-forget for ordinary renderer actions. Blocking actions wait until
 * the renderer reports success or failure.
 */
export function createRendererActionDispatcher(options: {
  mainWindow: () => BrowserWindow | null
  messages: () => RendererActionDispatchMessages
  timeoutMs?: number
}): RendererActionDispatcher {
  const pending = new Map<string, {
    resolve: (result: RendererActionResult) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  const timeoutMs = options.timeoutMs ?? RENDERER_ACTION_RECEIPT_TIMEOUT_MS

  function settle(requestId: string, result: RendererActionResult): boolean {
    const entry = pending.get(requestId)
    if (!entry) return false
    pending.delete(requestId)
    clearTimeout(entry.timer)
    entry.resolve(result)
    return true
  }

  function rendererAction(action: RendererAction): void | Promise<RendererActionResult> {
    const win = options.mainWindow()
    if (!isBlockingAction(action)) {
      win?.webContents.send('agent:renderer-action', { action })
      return
    }
    if (!win) return Promise.resolve({ ok: false, error: options.messages().noWindow })

    const requestId = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        settle(requestId, { ok: false, error: options.messages().timeout })
      }, timeoutMs)
      pending.set(requestId, { resolve, timer })
      win.webContents.send('agent:renderer-action', { action, requestId })
    })
  }

  return {
    rendererAction,
    complete: (requestId, result) => settle(requestId, result),
    abortAll: () => {
      const error = options.messages().aborted
      for (const [requestId] of pending) {
        settle(requestId, { ok: false, error })
      }
    },
  }
}
