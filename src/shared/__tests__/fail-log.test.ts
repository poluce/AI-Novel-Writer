import { afterEach, describe, expect, it, vi } from 'vitest'

import { describeError, logFailure, logInfo, setDiagnosticLogSink } from '../fail-log'

afterEach(() => {
  setDiagnosticLogSink(undefined)
  vi.restoreAllMocks()
})

describe('fail-log', () => {
  it('keeps Error message, stack, and code', () => {
    expect(describeError(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))).toMatchObject({
      message: 'disk full',
      code: 'ENOSPC',
    })
  })

  it('writes a structured console error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logFailure('MCP', 'connect failed', new Error('timeout'), { serverId: 'docs' })
    expect(spy).toHaveBeenCalledWith('[Vela MCP] connect failed', expect.objectContaining({
      serverId: 'docs',
      error: expect.objectContaining({ message: 'timeout' }),
    }))
  })

  it('forwards structured records to the diagnostic sink', () => {
    const sink = vi.fn()
    setDiagnosticLogSink(sink)
    logInfo('Agent', 'sending prompt', { conversationId: 'c1' })
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({
      level: 'info',
      scope: 'Agent',
      event: 'sending prompt',
      conversationId: 'c1',
    }))
  })
})
