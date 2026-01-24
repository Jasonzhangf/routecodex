type Jsonish =
  | null
  | boolean
  | number
  | string
  | Jsonish[]
  | { [key: string]: Jsonish };

export interface StripInternalKeysOptions {
  /**
   * Preserve specific internal keys (e.g. framework carriers).
   * Keys must match exactly (no glob).
   */
  preserveKeys?: ReadonlySet<string>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Removes keys that start with "__" from any object/array tree.
 * Intended for enforcing the E1 boundary rule (no internal env vars reach client/provider payloads).
 */
export function stripInternalKeysDeep<T>(value: T, options: StripInternalKeysOptions = {}): T {
  const preserve = options.preserveKeys ?? new Set<string>();
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripInternalKeysDeep(item, options)) as T;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.startsWith('__') && !preserve.has(key)) {
      continue;
    }
    out[key] = stripInternalKeysDeep(entry, options);
  }
  return out as T;
}

