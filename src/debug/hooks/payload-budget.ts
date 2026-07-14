import type { UnknownObject } from '../../types/common-types.js';

// feature_id: provider.debug_example_hooks_payload_copy_budget

export interface DebugPayloadBudgetOptions {
  maxDepth?: number;
  maxArrayItems?: number;
  maxObjectKeys?: number;
  maxStringLength?: number;
  maxEstimatedSize?: number;
}

const DEFAULT_DEBUG_PAYLOAD_BUDGET: Required<DebugPayloadBudgetOptions> = {
  maxDepth: 4,
  maxArrayItems: 8,
  maxObjectKeys: 24,
  maxStringLength: 512,
  maxEstimatedSize: Number.MAX_SAFE_INTEGER,
};

const CIRCULAR_MARKER = '[CIRCULAR]';

function resolveOptions(options: DebugPayloadBudgetOptions = {}): Required<DebugPayloadBudgetOptions> {
  return {
    ...DEFAULT_DEBUG_PAYLOAD_BUDGET,
    ...options,
  };
}

function cappedAdd(total: number, amount: number, cap: number): number {
  if (total > cap) {
    return cap + 1;
  }
  const next = total + amount;
  return next > cap ? cap + 1 : next;
}

function estimateStringSize(value: string): number {
  return value.length + 2;
}

function estimateValueSize(
  value: unknown,
  seen: WeakSet<object>,
  options: Required<DebugPayloadBudgetOptions>,
  total: number
): number {
  const cap = options.maxEstimatedSize;
  if (total > cap) {
    return cap + 1;
  }

  if (value === null) {
    return cappedAdd(total, 4, cap);
  }

  switch (typeof value) {
    case 'string':
      return cappedAdd(total, estimateStringSize(value), cap);
    case 'number':
    case 'boolean':
      return cappedAdd(total, String(value).length, cap);
    case 'bigint':
      return cappedAdd(total, String(value).length + 1, cap);
    case 'undefined':
    case 'function':
    case 'symbol':
      return cappedAdd(total, 0, cap);
    case 'object':
      break;
  }

  const objectValue = value as object;
  if (seen.has(objectValue)) {
    return cappedAdd(total, estimateStringSize(CIRCULAR_MARKER), cap);
  }
  seen.add(objectValue);

  if (Array.isArray(value)) {
    let next = cappedAdd(total, 2, cap);
    for (let index = 0; index < value.length; index += 1) {
      next = estimateValueSize(value[index], seen, options, next);
      if (index < value.length - 1) {
        next = cappedAdd(next, 1, cap);
      }
      if (next > cap) {
        return cap + 1;
      }
    }
    seen.delete(objectValue);
    return next;
  }

  let next = cappedAdd(total, 2, cap);
  let index = 0;
  const record = value as UnknownObject;
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      continue;
    }
    if (index > 0) {
      next = cappedAdd(next, 1, cap);
    }
    next = cappedAdd(next, estimateStringSize(key) + 1, cap);
    next = estimateValueSize(record[key], seen, options, next);
    index += 1;
    if (next > cap) {
      return cap + 1;
    }
  }
  seen.delete(objectValue);
  return next;
}

export function estimateDebugPayloadSize(value: unknown, options: DebugPayloadBudgetOptions = {}): number {
  const resolved = resolveOptions(options);
  return estimateValueSize(value, new WeakSet<object>(), resolved, 0);
}

function snapshotValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  options: Required<DebugPayloadBudgetOptions>
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    if (value.length <= options.maxStringLength) {
      return value;
    }
    return `${value.slice(0, options.maxStringLength)}...`;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'bigint') {
    return {
      __type: 'bigint',
      value: value.toString(),
    };
  }

  if (typeof value === 'function' || typeof value === 'symbol') {
    return {
      __type: typeof value,
    };
  }

  if (depth >= options.maxDepth) {
    return {
      __truncated: true,
      __reason: 'max_depth',
    };
  }

  const objectValue = value as object;
  if (seen.has(objectValue)) {
    return CIRCULAR_MARKER;
  }
  seen.add(objectValue);

  if (Array.isArray(value)) {
    const output: unknown[] = [];
    const visibleLength = Math.min(value.length, options.maxArrayItems);
    for (let index = 0; index < visibleLength; index += 1) {
      output.push(snapshotValue(value[index], seen, depth + 1, options));
    }
    if (value.length > visibleLength) {
      output.push({
        __truncatedItems: value.length - visibleLength,
      });
    }
    return output;
  }

  const record = value as UnknownObject;
  const output: UnknownObject = {};
  let copied = 0;
  let truncated = false;
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      continue;
    }
    if (copied >= options.maxObjectKeys) {
      truncated = true;
      break;
    }
    output[key] = snapshotValue(record[key], seen, depth + 1, options);
    copied += 1;
  }
  if (truncated) {
    output.__truncatedKeys = true;
  }
  return output;
}

export function buildDebugDataSnapshot(
  value: unknown,
  options: DebugPayloadBudgetOptions = {}
): unknown {
  return snapshotValue(value, new WeakSet<object>(), 0, resolveOptions(options));
}

export function buildDebugPayloadPreview(
  value: unknown,
  maxChars = 200,
  options: DebugPayloadBudgetOptions = {}
): string {
  const snapshot = buildDebugDataSnapshot(value, {
    maxArrayItems: 4,
    maxDepth: 3,
    maxObjectKeys: 12,
    maxStringLength: Math.max(32, maxChars),
    ...options,
  });
  const serialized = JSON.stringify(snapshot);
  return serialized.length > maxChars ? `${serialized.slice(0, maxChars)}...` : serialized;
}
