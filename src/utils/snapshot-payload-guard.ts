const DEFAULT_SNAPSHOT_PAYLOAD_MAX_BYTES = 256 * 1024;

function resolveBoolFromEnv(names: string[], fallback: boolean): boolean {
  for (const name of names) {
    const raw = String(process.env[name] ?? '').trim().toLowerCase();
    if (!raw) {
      continue;
    }
    if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') {
      return true;
    }
    if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') {
      return false;
    }
  }
  return fallback;
}

function normalizeStageToken(stage: string): string {
  return String(stage || '').trim().toLowerCase();
}

function shouldPreserveFullSnapshotPayload(stage: string): boolean {
  if (resolveBoolFromEnv(['ROUTECODEX_SNAPSHOT_FULL', 'RCC_SNAPSHOT_FULL'], false)) {
    return true;
  }
  const normalized = normalizeStageToken(stage);
  return normalized.startsWith('provider-request') || normalized.startsWith('provider-response');
}

function previewText(value: string, maxChars = 160): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

function summarizeResponsesInputItems(items: unknown[]): Record<string, unknown> {
  const roleCounts: Record<string, number> = {};
  let textChars = 0;
  const sampleTexts: string[] = [];
  for (const item of items.slice(0, 64)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const role = typeof record.role === 'string' && record.role.trim() ? record.role.trim() : 'unknown';
    roleCounts[role] = (roleCounts[role] || 0) + 1;
    const content = record.content;
    if (typeof content === 'string') {
      textChars += content.length;
      if (sampleTexts.length < 2 && content.trim()) {
        sampleTexts.push(previewText(content.trim(), 120));
      }
      continue;
    }
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (!part || typeof part !== 'object' || Array.isArray(part)) {
        continue;
      }
      const text =
        typeof (part as Record<string, unknown>).text === 'string'
          ? ((part as Record<string, unknown>).text as string)
          : typeof (part as Record<string, unknown>).input_text === 'string'
            ? ((part as Record<string, unknown>).input_text as string)
            : undefined;
      if (!text) {
        continue;
      }
      textChars += text.length;
      if (sampleTexts.length < 2 && text.trim()) {
        sampleTexts.push(previewText(text.trim(), 120));
      }
    }
  }
  return {
    itemCount: items.length,
    roleCounts,
    estimatedTextChars: textChars,
    sampleTexts
  };
}

function summarizeProviderRequestSnapshot(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const body = record.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }
  const request = body as Record<string, unknown>;
  const input = Array.isArray(request.input) ? request.input : [];
  const instructions = typeof request.instructions === 'string' ? request.instructions : '';
  const requestShape: Record<string, unknown> = {
    model: typeof request.model === 'string' ? request.model : null,
    previous_response_id:
      typeof request.previous_response_id === 'string' && request.previous_response_id.trim()
        ? request.previous_response_id.trim()
        : null,
    input: summarizeResponsesInputItems(input),
    instructions: instructions
      ? {
          chars: instructions.length,
          preview: previewText(instructions.trim(), 120)
        }
      : null,
    toolsCount: Array.isArray(request.tools) ? request.tools.length : 0,
    stream:
      typeof request.stream === 'boolean'
        ? request.stream
        : typeof request.stream === 'object' && request.stream && !Array.isArray(request.stream)
          ? request.stream
          : null
  };
  return {
    type: 'provider-request',
    keyCount: Object.keys(record).length,
    keys: Object.keys(record).slice(0, 24),
    requestShape
  };
}

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
  const providerRequestSummary = summarizeProviderRequestSnapshot(value);
  if (providerRequestSummary) {
    return providerRequestSummary;
  }
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
      preview: previewText(value)
    };
  }
  return {
    type: typeof value,
    value: value ?? null
  };
}

export function coerceSnapshotPayloadForWrite(stage: string, payload: unknown): unknown {
  if (shouldPreserveFullSnapshotPayload(stage)) {
    return payload;
  }
  const maxBytes = resolveSnapshotPayloadMaxBytes();
  const estimatedBytes = estimateSnapshotPayloadBytes(payload, { maxBytes: maxBytes + 1 });
  if (estimatedBytes <= maxBytes) {
    return payload;
  }
  return undefined;
}
