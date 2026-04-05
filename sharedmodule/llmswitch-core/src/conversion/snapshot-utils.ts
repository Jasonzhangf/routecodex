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
  void writeSnapshotViaHooks({
    endpoint,
    stage: options.stage,
    requestId: options.requestId,
    providerKey: options.providerKey,
    groupRequestId: options.groupRequestId,
    data: options.data,
    verbosity: 'verbose'
  }).catch(() => {
    // ignore hook errors
  });
}

export type SnapshotWriter = (stage: string, payload: unknown) => void;

const MAX_SNAPSHOT_QUEUE_SIZE = 2048;
const SNAPSHOT_QUEUE_BATCH_SIZE = 64;
const SNAPSHOT_QUEUE: Array<() => void> = [];
let snapshotQueueDrainScheduled = false;

function scheduleSnapshotQueueDrain(): void {
  if (snapshotQueueDrainScheduled) {
    return;
  }
  snapshotQueueDrainScheduled = true;
  setImmediate(() => {
    snapshotQueueDrainScheduled = false;
    let processed = 0;
    while (SNAPSHOT_QUEUE.length > 0 && processed < SNAPSHOT_QUEUE_BATCH_SIZE) {
      const task = SNAPSHOT_QUEUE.shift();
      if (!task) {
        continue;
      }
      try {
        task();
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

function enqueueSnapshotTask(task: () => void): void {
  if (SNAPSHOT_QUEUE.length >= MAX_SNAPSHOT_QUEUE_SIZE) {
    // keep newest writes; snapshot stream is best-effort and must not block request hot path
    SNAPSHOT_QUEUE.shift();
  }
  SNAPSHOT_QUEUE.push(task);
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
    enqueueSnapshotTask(() => {
      void recordSnapshot({
        stage,
        requestId: opts.requestId,
        endpoint,
        folderHint: opts.folderHint,
        providerKey: opts.providerKey,
        groupRequestId: opts.groupRequestId,
        data: payload
      });
    });
  };
}
