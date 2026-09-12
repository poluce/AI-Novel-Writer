export function describeError(error: unknown): { message: string; stack?: string; code?: string } {
  if (error instanceof Error) {
    const code = 'code' in error && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined
    return { message: error.message, stack: error.stack, ...(code ? { code } : {}) }
  }
  return { message: String(error) }
}

/** Diagnostic-only. Never used to swallow or replace the original failure. */
export function logFailure(
  scope: string,
  event: string,
  error?: unknown,
  extra?: Record<string, unknown>,
): void {
  console.error(`[Vela ${scope}] ${event}`, {
    ...extra,
    ...(error !== undefined ? { error: describeError(error) } : {}),
  })
}
