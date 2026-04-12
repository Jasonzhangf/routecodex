const DEFAULT_SNAPSHOT_PAYLOAD_MAX_BYTES = 256 * 1024;

function resolvePositiveIntegerFromEnv(names: string[], fallback: number): number {
  for (const name of names) {
    const raw = process.env[name];
    const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

function resolveSnapshotPayloadMaxBytes(): number {
  return resolvePositiveIntegerFromEnv(
    ['ROUTECODEX_SNAPSHOT_PAYLOAD_MAX_BYTES', 'RCC_SNAPSHOT_PAYLOAD_MAX_BYTES'],
    DEFAULT_SNAPSHOT_PAYLOAD_MAX_BYTES
  );
}

function estimateSnapshotPayloadBytes(
  value: unknown,
  options?: {
    maxBytes?: number;
    depth?: number;
    seen?: Set<unknown>;
  }
): number {
  const maxBytes = options?.maxBytes ?? Number.POSITIVE_INFINITY;
  const depth = options?.depth ?? 0;
  const seen = options?.seen ?? new Set<unknown>();

  if (value === null || value === undefined) {
    return 4;
  }
  const valueType = typeof value;
  if (valueType === 'string') {
    return Math.min(maxBytes + 1, (value as string).length * 2 + 2);
  }
  if (valueType === 'number') {
    return 8;
  }
  if (valueType === 'boolean') {
    return 4;
  }
  if (valueType === 'bigint') {
    return String(value).length + 8;
  }
  if (valueType === 'symbol' || valueType === 'function') {
    return 16;
  }

  if (seen.has(value)) {
    return 8;
  }
  seen.add(value);

  if (depth >= 8) {
    return 64;
  }

  let bytes = 0;
  if (Array.isArray(value)) {
    bytes += 2;
    for (const item of value) {
      bytes += estimateSnapshotPayloadBytes(item, {
        maxBytes: Math.max(0, maxBytes - bytes),
        depth: depth + 1,
        seen
      });
      if (bytes > maxBytes) {
        return maxBytes + 1;
      }
    }
    return bytes;
  }

  if (value && typeof value === 'object') {
    bytes += 2;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      bytes += key.length * 2 + 4;
      bytes += estimateSnapshotPayloadBytes(child, {
        maxBytes: Math.max(0, maxBytes - bytes),
        depth: depth + 1,
        seen
      });
      if (bytes > maxBytes) {
        return maxBytes + 1;
      }
    }
    return bytes;
  }

  return 16;
}

function summarizeSnapshotPayload(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      sampleTypes: value.slice(0, 8).map((item) => typeof item)
    };
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    return {
      type: 'object',
      keyCount: keys.length,
      keys: keys.slice(0, 24)
    };
  }
  if (typeof value === 'string') {
    return {
      type: 'string',
      length: value.length,
      preview: value.length > 160 ? `${value.slice(0, 160)}…` : value
    };
  }
  return {
    type: typeof value,
    value: value ?? null
  };
}

export function coerceSnapshotPayloadForWrite(stage: string, payload: unknown): unknown {
  const maxBytes = resolveSnapshotPayloadMaxBytes();
  const estimatedBytes = estimateSnapshotPayloadBytes(payload, { maxBytes: maxBytes + 1 });
  if (estimatedBytes <= maxBytes) {
    return payload;
  }
  return {
    __snapshot_truncated: true,
    stage,
    maxBytes,
    estimatedBytes,
    summary: summarizeSnapshotPayload(payload)
  };
}
