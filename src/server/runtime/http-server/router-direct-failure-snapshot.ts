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
  payload?: Record<string, unknown>;
  observedFields?: Array<{ field: string; value: unknown }>;
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

function accumulateTextStats(value: unknown): number {
  if (typeof value === 'string') {
    return value.length;
  }
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + accumulateTextStats(item), 0);
  }
  if (!value || typeof value !== 'object') {
    return 0;
  }
  let total = 0;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'text' || key === 'input_text' || key === 'output_text') {
      total += typeof child === 'string' ? child.length : accumulateTextStats(child);
      continue;
    }
    if (key === 'content' || key === 'arguments' || key === 'output' || key === 'summary') {
      total += accumulateTextStats(child);
    }
  }
  return total;
}

function summarizeArrayItems(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const typeCounts: Record<string, number> = {};
  const roleCounts: Record<string, number> = {};
  let estimatedTextChars = 0;
  for (const item of value) {
    const itemType = item && typeof item === 'object' && !Array.isArray(item)
      ? typeof (item as Record<string, unknown>).type === 'string'
        ? ((item as Record<string, unknown>).type as string)
        : 'object'
      : typeof item;
    typeCounts[itemType] = (typeCounts[itemType] || 0) + 1;
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const role = (item as Record<string, unknown>).role;
      if (typeof role === 'string' && role.trim()) {
        roleCounts[role.trim()] = (roleCounts[role.trim()] || 0) + 1;
      }
    }
    estimatedTextChars += accumulateTextStats(item);
  }
  return {
    count: value.length,
    typeCounts,
    estimatedTextChars,
    ...(Object.keys(roleCounts).length > 0 ? { roleCounts } : {}),
  };
}

function summarizeReasoning(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return {
    keys: Object.keys(record).sort(),
    effort: typeof record.effort === 'string' ? record.effort : undefined,
    summary: typeof record.summary === 'string' ? record.summary : undefined,
  };
}

function summarizeDirectPayloadShape(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!payload) {
    return undefined;
  }
  return {
    keys: Object.keys(payload).sort(),
    model: typeof payload.model === 'string' ? payload.model : undefined,
    stream: typeof payload.stream === 'boolean' ? payload.stream : undefined,
    hasMetadata: Object.prototype.hasOwnProperty.call(payload, 'metadata'),
    reasoning: summarizeReasoning(payload.reasoning),
    input: summarizeArrayItems(payload.input),
    messages: summarizeArrayItems(payload.messages),
    tools: summarizeArrayItems(payload.tools),
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
      providerRequestShape: summarizeDirectPayloadShape(args.payload),
      observedFields: args.observedFields,
    },
    entryEndpoint: args.entryEndpoint,
    entryPort: args.entryPort,
    providerKey: args.providerKey,
    providerId: args.providerId,
    metadata: args.metadata,
    forceLocalDiskWriteWhenDisabled: true,
  });
}
