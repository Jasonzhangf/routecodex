/**
 * Config Readers
 *
 * Utility functions for reading config values.
 */

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : undefined;
}

function getNestedRecord(source: UnknownRecord, path: string[]): UnknownRecord | undefined {
  let current: unknown = source;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) {
      return undefined;
    }
    current = record[key];
  }
  return asRecord(current);
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
      return false;
    }
  }
  return undefined;
}

function readRecordNumber(record: UnknownRecord | undefined, key: string): number | undefined {
  if (!record) {
    return undefined;
  }
  return readNumber(record[key]);
}

function readRecordString(record: UnknownRecord | undefined, key: string): string | undefined {
  if (!record) {
    return undefined;
  }
  return readString(record[key]);
}

function readRecordBoolean(record: UnknownRecord | undefined, key: string): boolean | undefined {
  if (!record) {
    return undefined;
  }
  const value = record[key];
  return readBoolean(value);
}

function truncateLogValue(value: string, maxLength = 256): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

function collectEnvHints(keys: string[]): Record<string, string> {
  const hints: Record<string, string> = {};
  for (const key of keys) {
    const raw = process.env[key];
    if (typeof raw !== 'string') {
      continue;
    }
    if (raw.length > 64) {
      hints[key] = `${raw.slice(0, 61)}...`;
    } else {
      hints[key] = raw;
    }
  }
  return hints;
}

export {
  asRecord,
  getNestedRecord,
  readNumber,
  readString,
  readBoolean,
  readRecordNumber,
  readRecordString,
  readRecordBoolean,
  truncateLogValue,
  collectEnvHints
};

export type { UnknownRecord };
