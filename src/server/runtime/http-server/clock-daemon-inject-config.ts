export function toExactMatchClockConfig(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return input;
  }
  const record = input as Record<string, unknown>;
  return {
    ...record,
    dueWindowMs: 0
  };
}

