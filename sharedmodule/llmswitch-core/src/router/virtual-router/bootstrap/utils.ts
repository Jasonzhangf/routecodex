export function asRecord<T extends Record<string, unknown>>(value: unknown): T {
  return (value && typeof value === 'object' ? value : {}) as T;
}

export function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

export function normalizeAlias(candidate: string | undefined, existing: Set<string>): string {
  const base = candidate && candidate.trim() ? candidate.trim() : `key${existing.size + 1}`;
  let alias = base;
  let i = 1;
  while (existing.has(alias)) {
    alias = `${base}_${i}`;
    i += 1;
  }
  return alias;
}

export function pushUnique<T>(list: T[], value: T): void {
  if (!list.includes(value)) {
    list.push(value);
  }
}
