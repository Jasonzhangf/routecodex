const RETRY_PAYLOAD_ESTIMATE_NODE_BUDGET = 4000;

export function estimateRetryPayloadBytes(
  value: unknown,
  options?: {
    maxBytes?: number;
    depth?: number;
    seen?: Set<unknown>;
    nodeBudget?: number;
    visitedNodes?: number;
  }
): number {
  const maxBytes = options?.maxBytes ?? Number.POSITIVE_INFINITY;
  const depth = options?.depth ?? 0;
  const seen = options?.seen ?? new Set<unknown>();
  const nodeBudget = options?.nodeBudget ?? RETRY_PAYLOAD_ESTIMATE_NODE_BUDGET;
  const visitedNodes = (options?.visitedNodes ?? 0) + 1;

  if (visitedNodes > nodeBudget) {
    return maxBytes + 1;
  }

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
      bytes += estimateRetryPayloadBytes(item, {
        maxBytes: Math.max(0, maxBytes - bytes),
        depth: depth + 1,
        seen,
        nodeBudget,
        visitedNodes
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
      bytes += estimateRetryPayloadBytes(child, {
        maxBytes: Math.max(0, maxBytes - bytes),
        depth: depth + 1,
        seen,
        nodeBudget,
        visitedNodes
      });
      if (bytes > maxBytes) {
        return maxBytes + 1;
      }
    }
    return bytes;
  }
  return 16;
}
