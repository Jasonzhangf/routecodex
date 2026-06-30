import { writeProviderSnapshot } from '../../../providers/core/utils/snapshot-writer.js';

type RouterDirectSnapshotArgs = {
  requestId: string;
  entryEndpoint: string;
  providerKey: string;
  providerId?: string;
  entryPort?: number;
  metadata?: Record<string, unknown>;
};

type RouterDirectResponseSnapshotArgs = RouterDirectSnapshotArgs & {
  response: unknown;
};

type RouterDirectFailureSnapshotArgs = RouterDirectSnapshotArgs & {
  error: unknown;
};

type ProviderSnapshotWriter = typeof writeProviderSnapshot;

function serializeError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}

export async function captureRouterDirectProviderResponseSnapshot(
  args: RouterDirectResponseSnapshotArgs,
  writer: ProviderSnapshotWriter = writeProviderSnapshot,
): Promise<void> {
  await writer({
    phase: 'provider-response',
    requestId: args.requestId,
    data: args.response,
    entryEndpoint: args.entryEndpoint,
    entryPort: args.entryPort,
    providerKey: args.providerKey,
    providerId: args.providerId,
    metadata: args.metadata,
  });
}

export async function captureRouterDirectFailureSnapshots(
  args: RouterDirectFailureSnapshotArgs,
  writer: ProviderSnapshotWriter = writeProviderSnapshot,
): Promise<void> {
  await writer({
    phase: 'provider-response',
    requestId: args.requestId,
    data: {
      error: serializeError(args.error),
    },
    entryEndpoint: args.entryEndpoint,
    entryPort: args.entryPort,
    providerKey: args.providerKey,
    providerId: args.providerId,
    metadata: args.metadata,
    forceLocalDiskWriteWhenDisabled: true,
  });
}
