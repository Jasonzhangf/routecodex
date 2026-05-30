export function getUnknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

export function getUnknownErrorRecord(error: unknown): Record<string, unknown> | null {
  return error && typeof error === 'object' ? error as Record<string, unknown> : null;
}

export function assignErrorFields(error: Error, fields: Record<string, unknown>): Error {
  Object.assign(error as Error & Record<string, unknown>, fields);
  return error;
}

export function resolveBackoffDelayMs(attempt: number, backoffsMs: number[], defaultMs = 1000): number {
  return backoffsMs[attempt] ?? backoffsMs[backoffsMs.length - 1] ?? defaultMs;
}
