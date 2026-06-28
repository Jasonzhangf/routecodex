const METADATA_CENTER_SYMBOL = Symbol.for('routecodex.metadataCenter');

type RuntimeControlWriter = {
  module: string;
  symbol: string;
  stage: string;
};

type StoplessRuntimeControlValue = {
  flowId: string;
  repeatCount: number;
  maxRepeats: number;
  triggerHint?: string;
  continuationPrompt?: string;
  schemaFeedback?: Record<string, unknown>;
  active: boolean;
  updatedAt?: number;
};

export type { StoplessRuntimeControlValue };

type MetadataCenterLike = {
  writeRuntimeControl?: (
    key: string,
    value: unknown,
    writtenBy: RuntimeControlWriter,
    reason?: string
  ) => void;
  readRuntimeControl?: () => Record<string, unknown>;
  readRequestTruth?: () => Record<string, unknown> | undefined;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function writeBoundRuntimeControl(args: {
  center: MetadataCenterLike;
  key: string;
  value: unknown;
  writer: RuntimeControlWriter;
  reason?: string;
}): void {
  args.center.writeRuntimeControl?.(args.key, args.value, args.writer, args.reason);
}

export function writeStoplessRuntimeControlToBoundMetadataCenter(args: {
  metadata: Record<string, unknown>;
  value: StoplessRuntimeControlValue;
  writer: RuntimeControlWriter;
  reason?: string;
  required?: boolean;
}): void {
  const directCenter = Reflect.get(args.metadata, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  const nestedMetadata = asRecord(args.metadata.metadata);
  const nestedCenter = nestedMetadata
    ? (Reflect.get(nestedMetadata, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined)
    : undefined;
  const center = directCenter && typeof directCenter.writeRuntimeControl === 'function'
    ? directCenter
    : nestedCenter;
  if (!center || typeof center.writeRuntimeControl !== 'function') {
    if (args.required) {
      throw new Error('MetadataCenter runtime_control.stopless writer requires a bound MetadataCenter');
    }
    return;
  }
  writeBoundRuntimeControl({
    center,
    key: 'stopless',
    value: args.value,
    writer: args.writer,
    reason: args.reason
  });
}

export function writeRuntimeControlToBoundMetadataCenter(args: {
  metadata: Record<string, unknown>;
  key: string;
  value: unknown;
  writer: RuntimeControlWriter;
  reason?: string;
  required?: boolean;
}): void {
  const directCenter = Reflect.get(args.metadata, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  const nestedMetadata = asRecord(args.metadata.metadata);
  const nestedCenter = nestedMetadata
    ? (Reflect.get(nestedMetadata, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined)
    : undefined;
  const center = directCenter && typeof directCenter.writeRuntimeControl === 'function'
    ? directCenter
    : nestedCenter;
  if (!center || typeof center.writeRuntimeControl !== 'function') {
    if (args.required) {
      throw new Error(`MetadataCenter runtime_control.${args.key} writer requires a bound MetadataCenter`);
    }
    return;
  }
  writeBoundRuntimeControl({
    center,
    key: args.key,
    value: args.value,
    writer: args.writer,
    reason: args.reason
  });
}

export function readRuntimeControlFromBoundMetadataCenter(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }
  const center = Reflect.get(metadata, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  if (!center || typeof center.readRuntimeControl !== 'function') {
    return undefined;
  }
  const runtimeControl = center.readRuntimeControl();
  return runtimeControl && typeof runtimeControl === 'object' && !Array.isArray(runtimeControl)
    ? runtimeControl
    : undefined;
}

export function readRuntimeControlFromAnyBoundMetadataCenter(
  target: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const direct = readRuntimeControlFromBoundMetadataCenter(target);
  if (direct) {
    return direct;
  }
  const metadata = asRecord(target?.metadata);
  return readRuntimeControlFromBoundMetadataCenter(metadata);
}

export function readStoplessRuntimeControlFromAnyBoundMetadataCenter(
  target: Record<string, unknown> | undefined
): StoplessRuntimeControlValue | undefined {
  const runtimeControl = readRuntimeControlFromAnyBoundMetadataCenter(target);
  const stopless = runtimeControl?.stopless;
  if (!stopless || typeof stopless !== 'object' || Array.isArray(stopless)) {
    return undefined;
  }
  const record = stopless as Record<string, unknown>;
  if (typeof record.flowId !== 'string') {
    return undefined;
  }
  if (typeof record.repeatCount !== 'number' || typeof record.maxRepeats !== 'number') {
    return undefined;
  }
  if (typeof record.active !== 'boolean') {
    return undefined;
  }
  return {
    flowId: record.flowId,
    repeatCount: record.repeatCount,
    maxRepeats: record.maxRepeats,
    ...(typeof record.triggerHint === 'string' ? { triggerHint: record.triggerHint } : {}),
    ...(typeof record.continuationPrompt === 'string' ? { continuationPrompt: record.continuationPrompt } : {}),
    ...(record.schemaFeedback && typeof record.schemaFeedback === 'object' && !Array.isArray(record.schemaFeedback)
      ? { schemaFeedback: record.schemaFeedback as Record<string, unknown> }
      : {}),
    active: record.active,
    ...(typeof record.updatedAt === 'number' ? { updatedAt: record.updatedAt } : {}),
  };
}

export function readProviderProtocolFromAnyBoundMetadataCenter(
  target: Record<string, unknown> | undefined
): string | undefined {
  const runtimeControl = readRuntimeControlFromAnyBoundMetadataCenter(target);
  const providerProtocol = runtimeControl?.providerProtocol;
  return typeof providerProtocol === 'string' && providerProtocol.trim()
    ? providerProtocol.trim()
    : undefined;
}

export function readRequestTruthSessionIdFromBoundMetadataCenter(
  metadata: Record<string, unknown> | undefined
): string | undefined {
  if (!metadata) {
    return undefined;
  }
  const center = Reflect.get(metadata, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  if (!center || typeof center.readRequestTruth !== 'function') {
    return undefined;
  }
  const requestTruth = center.readRequestTruth();
  const sessionId = requestTruth?.sessionId;
  return typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : undefined;
}

export function readRequestTruthSessionIdFromAnyBoundMetadataCenter(
  target: Record<string, unknown> | undefined
): string | undefined {
  const direct = readRequestTruthSessionIdFromBoundMetadataCenter(target);
  if (direct) {
    return direct;
  }
  const metadata = asRecord(target?.metadata);
  return readRequestTruthSessionIdFromBoundMetadataCenter(metadata);
}
