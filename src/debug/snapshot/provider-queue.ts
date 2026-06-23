// Queue/drain/budget for provider snapshot writes
// feature_id: snapshot.stage_contract

import { writeUnifiedSnapshot } from './writer.js';
import type { ProviderSnapshotPersistInput } from './buffer.js';
import { resolvePositiveIntegerFromEnv } from './provider-utils.js';

const DEFAULT_PROVIDER_SNAPSHOT_QUEUE_MAX_ITEMS = 32;
const DEFAULT_PROVIDER_SNAPSHOT_QUEUE_MEMORY_BUDGET_BYTES = 8 * 1024 * 1024;
const DEFAULT_PROVIDER_SNAPSHOT_QUEUE_BATCH_SIZE = 8;
const PROVIDER_SNAPSHOT_QUEUE: ProviderSnapshotQueueItem[] = [];
let providerSnapshotQueueBytes = 0;
let providerSnapshotDrainScheduled = false;
let providerSnapshotDrainInFlight: Promise<void> | null = null;
let providerSnapshotDroppedCount = 0;
let providerSnapshotLastDropLogAt = 0;

type ProviderSnapshotQueueItem = {
  input: ProviderSnapshotPersistInput;
  sizeBytes: number;
};

function resolveProviderSnapshotQueueMaxItems(): number {
  return resolvePositiveIntegerFromEnv(
    ['ROUTECODEX_PROVIDER_SNAPSHOT_QUEUE_MAX_ITEMS', 'RCC_PROVIDER_SNAPSHOT_QUEUE_MAX_ITEMS'],
    DEFAULT_PROVIDER_SNAPSHOT_QUEUE_MAX_ITEMS
  );
}

function resolveProviderSnapshotQueueMemoryBudgetBytes(): number {
  return resolvePositiveIntegerFromEnv(
    ['ROUTECODEX_PROVIDER_SNAPSHOT_QUEUE_MEMORY_BUDGET_BYTES', 'RCC_PROVIDER_SNAPSHOT_QUEUE_MEMORY_BUDGET_BYTES'],
    DEFAULT_PROVIDER_SNAPSHOT_QUEUE_MEMORY_BUDGET_BYTES
  );
}

function resolveProviderSnapshotQueueBatchSize(): number {
  return resolvePositiveIntegerFromEnv(
    ['ROUTECODEX_PROVIDER_SNAPSHOT_QUEUE_BATCH_SIZE', 'RCC_PROVIDER_SNAPSHOT_QUEUE_BATCH_SIZE'],
    DEFAULT_PROVIDER_SNAPSHOT_QUEUE_BATCH_SIZE
  );
}

function estimateProviderSnapshotQueueBytes(input: ProviderSnapshotPersistInput): number {
  try {
    const json = JSON.stringify(input.payload);
    if (typeof json === 'string' && json.length > 0) {
      return Math.max(1, Buffer.byteLength(json, 'utf8'));
    }
  } catch {
    // fall through
  }
  return 1024;
}

function logNonBlockingError(operation: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`[provider-snapshot] ${operation} failed (non-blocking): ${reason}`);
}

function flushProviderSnapshotDropLog(force = false): void {
  if (providerSnapshotDroppedCount <= 0) {
    return;
  }
  const now = Date.now();
  if (!force && now - providerSnapshotLastDropLogAt < 10_000) {
    return;
  }
  providerSnapshotLastDropLogAt = now;
  const dropped = providerSnapshotDroppedCount;
  providerSnapshotDroppedCount = 0;
  console.warn(
    `[provider-snapshot] queue overflow: dropped ${dropped} old snapshot task(s) ` +
    `(pending=${PROVIDER_SNAPSHOT_QUEUE.length}, bytes=${providerSnapshotQueueBytes})`
  );
}

async function persistProviderSnapshot(input: ProviderSnapshotPersistInput, forceLocalDiskWriteWhenDisabled = false): Promise<void> {
  await writeUnifiedSnapshot({
    scope: 'provider',
    stage: input.stage,
    requestId: input.requestId,
    groupRequestId: input.groupRequestId,
    providerKey: input.providerToken || undefined,
    entryEndpoint: input.endpoint,
    entryPort: input.entryPort,
    data: input.payload,
    rawPayload: input.payload,
    verbosity: 'verbose',
    forceLocalDiskWriteWhenDisabled,
  });
}

async function drainProviderSnapshotQueue(): Promise<void> {
  const batchSize = resolveProviderSnapshotQueueBatchSize();
  let processed = 0;
  while (PROVIDER_SNAPSHOT_QUEUE.length > 0 && processed < batchSize) {
    const item = PROVIDER_SNAPSHOT_QUEUE.shift();
    if (!item) {
      continue;
    }
    providerSnapshotQueueBytes = Math.max(0, providerSnapshotQueueBytes - Math.max(1, item.sizeBytes));
    await persistProviderSnapshot(item.input);
    processed += 1;
  }
  flushProviderSnapshotDropLog();
}

function scheduleProviderSnapshotDrain(): void {
  if (providerSnapshotDrainScheduled || providerSnapshotDrainInFlight) {
    return;
  }
  providerSnapshotDrainScheduled = true;
  setImmediate(() => {
    providerSnapshotDrainScheduled = false;
    if (providerSnapshotDrainInFlight) {
      return;
    }
    providerSnapshotDrainInFlight = drainProviderSnapshotQueue()
      .catch((error) => {
        logNonBlockingError('providerSnapshotQueueDrain', error);
      })
      .finally(() => {
        providerSnapshotDrainInFlight = null;
        if (PROVIDER_SNAPSHOT_QUEUE.length > 0) {
          scheduleProviderSnapshotDrain();
        } else {
          flushProviderSnapshotDropLog(true);
        }
      });
  });
}

function enqueueProviderSnapshotPersist(input: ProviderSnapshotPersistInput): void {
  const sizeBytes = estimateProviderSnapshotQueueBytes(input);
  const queueMaxItems = resolveProviderSnapshotQueueMaxItems();
  const queueBudgetBytes = resolveProviderSnapshotQueueMemoryBudgetBytes();
  while (
    PROVIDER_SNAPSHOT_QUEUE.length > 0
    && (PROVIDER_SNAPSHOT_QUEUE.length >= queueMaxItems || providerSnapshotQueueBytes + sizeBytes > queueBudgetBytes)
  ) {
    const dropped = PROVIDER_SNAPSHOT_QUEUE.shift();
    if (!dropped) {
      break;
    }
    providerSnapshotQueueBytes = Math.max(0, providerSnapshotQueueBytes - Math.max(1, dropped.sizeBytes));
    providerSnapshotDroppedCount += 1;
  }
  PROVIDER_SNAPSHOT_QUEUE.push({ input, sizeBytes });
  providerSnapshotQueueBytes += sizeBytes;
  scheduleProviderSnapshotDrain();
}

export function __resetProviderSnapshotQueueForTests(): void {
  PROVIDER_SNAPSHOT_QUEUE.splice(0, PROVIDER_SNAPSHOT_QUEUE.length);
  providerSnapshotQueueBytes = 0;
  providerSnapshotDrainScheduled = false;
  providerSnapshotDroppedCount = 0;
  providerSnapshotLastDropLogAt = 0;
}

export async function __flushProviderSnapshotQueueForTests(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (
      PROVIDER_SNAPSHOT_QUEUE.length === 0
      && providerSnapshotQueueBytes === 0
      && !providerSnapshotDrainScheduled
      && !providerSnapshotDrainInFlight
    ) {
      flushProviderSnapshotDropLog(true);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('provider snapshot queue did not flush in time');
}

export function enqueueSnapshotPersist(input: ProviderSnapshotPersistInput): void {
  enqueueProviderSnapshotPersist(input);
}

export { logNonBlockingError as logSnapshotNonBlockingError };
