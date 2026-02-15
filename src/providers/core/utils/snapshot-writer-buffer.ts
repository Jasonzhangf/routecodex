export type ProviderSnapshotPersistInput = {
  endpoint: string;
  folder: string;
  stage: string;
  requestId: string;
  groupRequestId: string;
  providerToken: string;
  payload: unknown;
};

type SnapshotBufferGlobal = {
  __routecodexProviderSnapshotErrorBuffer?: Map<string, ProviderSnapshotPersistInput[]>;
};

const PROVIDER_SNAPSHOT_BUFFER_MAX_REQUESTS = 128;
const PROVIDER_SNAPSHOT_BUFFER_MAX_ENTRIES_PER_REQUEST = 24;

function getProviderSnapshotErrorBuffer(): Map<string, ProviderSnapshotPersistInput[]> {
  const scope = globalThis as SnapshotBufferGlobal;
  if (!scope.__routecodexProviderSnapshotErrorBuffer) {
    scope.__routecodexProviderSnapshotErrorBuffer = new Map<string, ProviderSnapshotPersistInput[]>();
  }
  return scope.__routecodexProviderSnapshotErrorBuffer;
}

export function shouldFlushSnapshotBuffer(stage: string): boolean {
  const normalized = String(stage || '').trim().toLowerCase();
  return normalized.includes('error');
}

export function bufferProviderSnapshotForErrorFlush(input: ProviderSnapshotPersistInput): void {
  const buffer = getProviderSnapshotErrorBuffer();
  const bucket = buffer.get(input.groupRequestId) ?? [];
  bucket.push(input);
  if (bucket.length > PROVIDER_SNAPSHOT_BUFFER_MAX_ENTRIES_PER_REQUEST) {
    bucket.splice(0, bucket.length - PROVIDER_SNAPSHOT_BUFFER_MAX_ENTRIES_PER_REQUEST);
  }
  buffer.set(input.groupRequestId, bucket);

  while (buffer.size > PROVIDER_SNAPSHOT_BUFFER_MAX_REQUESTS) {
    const oldest = buffer.keys().next().value;
    if (!oldest) {
      break;
    }
    buffer.delete(oldest);
  }
}

export function takeBufferedProviderSnapshots(groupRequestId: string): ProviderSnapshotPersistInput[] {
  const buffer = getProviderSnapshotErrorBuffer();
  const batch = buffer.get(groupRequestId) ?? [];
  buffer.delete(groupRequestId);
  return batch;
}

export function resetProviderSnapshotErrorBufferForTests(): void {
  getProviderSnapshotErrorBuffer().clear();
}
