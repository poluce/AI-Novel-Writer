import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  abortAllPiInFlight,
  abortPiInFlight,
  abortPiOnProjectClose,
  acquirePiOneShotSlot,
  PiConcurrencyError,
  PI_MAX_ONE_SHOT,
  piInFlightCount,
  piOneShotActiveCount,
  registerPiInFlight,
  resetPiInFlightForTests,
  setPiProjectCloseHook,
} from '../in-flight'

afterEach(() => {
  resetPiInFlightForTests()
})

describe('pi in-flight registry', () => {
  it('aborts a registered request by id', () => {
    const abort = vi.fn()
    registerPiInFlight('shot-1', { abort })

    expect(abortPiInFlight('shot-1')).toBe(true)
    expect(abort).toHaveBeenCalledOnce()
    expect(abortPiInFlight('missing')).toBe(false)
  })

  it('drops a request when its disposer runs', () => {
    const abort = vi.fn()
    const dispose = registerPiInFlight('shot-1', { abort })
    dispose()

    expect(piInFlightCount()).toBe(0)
    expect(abortPiInFlight('shot-1')).toBe(false)
    expect(abort).not.toHaveBeenCalled()
  })

  it('aborts every registered request', () => {
    const first = vi.fn()
    const second = vi.fn()
    registerPiInFlight('a', { abort: first })
    registerPiInFlight('b', { abort: second })

    abortAllPiInFlight()

    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
  })

  it('caps concurrent one-shot slots', () => {
    const slots = Array.from({ length: PI_MAX_ONE_SHOT }, () => acquirePiOneShotSlot())
    expect(piOneShotActiveCount()).toBe(PI_MAX_ONE_SHOT)
    expect(() => acquirePiOneShotSlot()).toThrow(PiConcurrencyError)
    slots[0]!()
    expect(() => acquirePiOneShotSlot()).not.toThrow()
    expect(piOneShotActiveCount()).toBe(PI_MAX_ONE_SHOT)
  })

  it('runs the project-close hook', () => {
    const hook = vi.fn()
    setPiProjectCloseHook(hook)
    abortPiOnProjectClose()
    expect(hook).toHaveBeenCalledOnce()
    setPiProjectCloseHook(abortAllPiInFlight)
  })
})
