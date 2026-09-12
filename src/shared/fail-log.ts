export function describeError(error: unknown): { message: string; stack?: string; code?: string } {
  if (error instanceof Error) {
    const code = 'code' in error && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined
    return { message: error.message, stack: error.stack, ...(code ? { code } : {}) }
  }
  return { message: String(error) }
}

export interface DiagnosticLogRecord {
  ts: string
  level: 'error' | 'info'
  scope: string
  event: string
  error?: ReturnType<typeof describeError>
  [key: string]: unknown
}

type DiagnosticLogSink = (record: DiagnosticLogRecord) => void

let sink: DiagnosticLogSink | undefined

export function setDiagnosticLogSink(next: DiagnosticLogSink | undefined): void {
  sink = next
}

function emit(
  level: DiagnosticLogRecord['level'],
  scope: string,
  event: string,
  error?: unknown,
  extra?: Record<string, unknown>,
): void {
  const record: DiagnosticLogRecord = {
    ts: new Date().toISOString(),
    level,
    scope,
    event,
    ...extra,
    ...(error !== undefined ? { error: describeError(error) } : {}),
  }
  if (level === 'error') {
    console.error(`[Vela ${scope}] ${event}`, {
      ...extra,
      ...(error !== undefined ? { error: record.error } : {}),
    })
  } else {
    console.info(`[Vela ${scope}] ${event}`, extra ?? {})
  }
  try {
    sink?.(record)
  } catch {
    // File/IPC sink must never replace the original diagnostic console line.
  }
}

/** Diagnostic-only. Never used to swallow or replace the original failure. */
export function logFailure(
  scope: string,
  event: string,
  error?: unknown,
  extra?: Record<string, unknown>,
): void {
  emit('error', scope, event, error, extra)
}

export function logInfo(
  scope: string,
  event: string,
  extra?: Record<string, unknown>,
): void {
  emit('info', scope, event, undefined, extra)
}
