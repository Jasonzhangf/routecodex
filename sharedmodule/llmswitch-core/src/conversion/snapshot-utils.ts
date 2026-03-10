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
    void recordSnapshot({
      stage,
      requestId: opts.requestId,
      endpoint,
      folderHint: opts.folderHint,
      providerKey: opts.providerKey,
      groupRequestId: opts.groupRequestId,
      data: payload
    });
  };
}
