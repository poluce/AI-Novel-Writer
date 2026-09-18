import { afterEach, describe, expect, it } from 'vitest'

import {
  closeProjectDatabase,
  setProjectDatabaseClosingHandler,
} from '../database'

afterEach(() => {
  setProjectDatabaseClosingHandler(null)
})

describe('project database lifecycle hooks', () => {
  it('runs the registered closing handler even when no database is open', () => {
    const calls: string[] = []
    setProjectDatabaseClosingHandler(() => {
      calls.push('close')
    })
    closeProjectDatabase()
    expect(calls).toEqual(['close'])
  })
})
