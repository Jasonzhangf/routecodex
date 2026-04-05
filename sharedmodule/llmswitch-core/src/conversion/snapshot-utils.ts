import {
  shouldRecordSnapshotsWithNative,
  writeSnapshotViaHooksWithNative
} from '../router/virtual-router/engine-selection/native-snapshot-hooks.js';

export interface SnapshotHookOptions {
  endpoint: string;
  stage: string;
  requestId: string;
  data: unknown;
  verbosity?: 'minimal' | 'verbose';
  channel?: string;
  providerKey?: string;
  groupRequestId?: string;
}

interface SnapshotPayload {
  stage: string;
  requestId: string;
  endpoint?: string;
  data: unknown;
  folderHint?: string;
  providerKey?: string;
  groupRequestId?: string;
}

export function shouldRecordSnapshots(): boolean {
  return shouldRecordSnapshotsWithNative();
}

export async function writeSnapshotViaHooks(options: SnapshotHookOptions): Promise<void> {
  writeSnapshotViaHooksWithNative({
    endpoint: options.endpoint,
    stage: options.stage,
    requestId: options.requestId,
    data: options.data,
    verbosity: options.verbosity,
    channel: options.channel,
    providerKey: options.providerKey,
    groupRequestId: options.groupRequestId
  });
}

export async function recordSnapshot(options: SnapshotPayload): Promise<void> {
  if (!shouldRecordSnapshots()) return;
  const endpoint = options.endpoint || '/v1/chat/completions';
  const prepared = coerceSnapshotPayloadForWrite(options.stage, options.data);
  void writeSnapshotViaHooks({
    endpoint,
    stage: options.stage,
    requestId: options.requestId,
    providerKey: options.providerKey,
    groupRequestId: options.groupRequestId,
    data: prepared.data,
    verbosity: 'verbose'
  }).catch(() => {
    // ignore hook errors
  });
}

export type SnapshotWriter = (stage: string, payload: unknown) => void;

const DEFAULT_SNAPSHOT_QUEUE_MAX_ITEMS = 10;
const SNAPSHOT_QUEUE_BATCH_SIZE = 64;
const DEFAULT_SNAPSHOT_PAYLOAD_MAX_BYTES = 256 * 1024;
const DEFAULT_SNAPSHOT_QUEUE_MEMORY_BUDGET_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_QUEUE: Array<{ task: () => void; sizeBytes: number }> = [];
let snapshotQueueBytes = 0;
let snapshotQueueDrainScheduled = false;

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

function resolveSnapshotQueueMemoryBudgetBytes(): number {
  return resolvePositiveIntegerFromEnv(
    ['ROUTECODEX_SNAPSHOT_QUEUE_MEMORY_BUDGET_BYTES', 'RCC_SNAPSHOT_QUEUE_MEMORY_BUDGET_BYTES'],
    DEFAULT_SNAPSHOT_QUEUE_MEMORY_BUDGET_BYTES
  );
}

function resolveSnapshotQueueMaxItems(): number {
  return resolvePositiveIntegerFromEnv(
    ['ROUTECODEX_SNAPSHOT_QUEUE_MAX_ITEMS', 'RCC_SNAPSHOT_QUEUE_MAX_ITEMS'],
    DEFAULT_SNAPSHOT_QUEUE_MAX_ITEMS
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

function coerceSnapshotPayloadForWrite(stage: string, payload: unknown): { data: unknown; sizeBytes: number } {
  const maxBytes = resolveSnapshotPayloadMaxBytes();
  const estimatedBytes = estimateSnapshotPayloadBytes(payload, { maxBytes: maxBytes + 1 });
  if (estimatedBytes <= maxBytes) {
    return {
      data: payload,
      sizeBytes: Math.max(1, estimatedBytes)
    };
  }
  return {
    data: {
      __snapshot_truncated: true,
      stage,
      maxBytes,
      estimatedBytes,
      summary: summarizeSnapshotPayload(payload)
    },
    sizeBytes: 512
  };
}

function scheduleSnapshotQueueDrain(): void {
  if (snapshotQueueDrainScheduled) {
    return;
  }
  snapshotQueueDrainScheduled = true;
  setImmediate(() => {
    snapshotQueueDrainScheduled = false;
    let processed = 0;
    while (SNAPSHOT_QUEUE.length > 0 && processed < SNAPSHOT_QUEUE_BATCH_SIZE) {
      const item = SNAPSHOT_QUEUE.shift();
      if (!item) {
        continue;
      }
      snapshotQueueBytes = Math.max(0, snapshotQueueBytes - Math.max(1, item.sizeBytes));
      try {
        item.task();
      } catch {
        // snapshot write failures are non-blocking by design
      }
      processed += 1;
    }
    if (SNAPSHOT_QUEUE.length > 0) {
      scheduleSnapshotQueueDrain();
    }
  });
}

function enqueueSnapshotTask(task: () => void, sizeBytes: number): void {
  const normalizedSize = Math.max(1, Math.floor(sizeBytes));
  const queueBudgetBytes = resolveSnapshotQueueMemoryBudgetBytes();
  const queueMaxItems = resolveSnapshotQueueMaxItems();
  while (
    SNAPSHOT_QUEUE.length > 0
    && (SNAPSHOT_QUEUE.length >= queueMaxItems || snapshotQueueBytes + normalizedSize > queueBudgetBytes)
  ) {
    const dropped = SNAPSHOT_QUEUE.shift();
    if (!dropped) {
      break;
    }
    snapshotQueueBytes = Math.max(0, snapshotQueueBytes - Math.max(1, dropped.sizeBytes));
  }
  SNAPSHOT_QUEUE.push({ task, sizeBytes: normalizedSize });
  snapshotQueueBytes += normalizedSize;
  scheduleSnapshotQueueDrain();
}

export function createSnapshotWriter(opts: {
  requestId: string;
  endpoint?: string;
  folderHint?: string;
  providerKey?: string;
  groupRequestId?: string;
}): SnapshotWriter | undefined {
  if (!shouldRecordSnapshots()) {
    return undefined;
  }
  const endpoint = opts.endpoint || '/v1/chat/completions';
  return (stage: string, payload: unknown) => {
    const prepared = coerceSnapshotPayloadForWrite(stage, payload);
    enqueueSnapshotTask(() => {
      void recordSnapshot({
        stage,
        requestId: opts.requestId,
        endpoint,
        folderHint: opts.folderHint,
        providerKey: opts.providerKey,
        groupRequestId: opts.groupRequestId,
        data: prepared.data
      });
    }, prepared.sizeBytes);
  };
}
