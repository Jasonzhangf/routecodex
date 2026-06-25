const METADATA_CENTER_SYMBOL = Symbol.for('routecodex.metadataCenter');
const RUST_SNAPSHOT_SYMBOL = Symbol.for('routecodex.metadataCenter.rustSnapshot');

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

function readRustSnapshot(metadata: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(asRecord(Reflect.get(metadata, RUST_SNAPSHOT_SYMBOL)) ?? {});
}

function writeRustRuntimeControlMirror(args: {
  metadata: Record<string, unknown>;
  key: string;
  value: unknown;
  reason?: string;
}): void {
  const snapshot = readRustSnapshot(args.metadata);
  const runtimeControl = asRecord(snapshot.runtimeControl) ?? {};
  runtimeControl[args.key] = structuredClone(args.value);
  snapshot.runtimeControl = runtimeControl;
  Reflect.set(args.metadata, RUST_SNAPSHOT_SYMBOL, snapshot);
}

function writeBoundRuntimeControl(args: {
  center: MetadataCenterLike;
  metadata: Record<string, unknown>;
  key: string;
  value: unknown;
  writer: RuntimeControlWriter;
  reason?: string;
}): void {
  args.center.writeRuntimeControl?.(args.key, args.value, args.writer, args.reason);
  writeRustRuntimeControlMirror(args);
}

export function writeStoplessRuntimeControlToBoundMetadataCenter(args: {
  metadata: Record<string, unknown>;
  value: StoplessRuntimeControlValue;
  writer: RuntimeControlWriter;
  reason?: string;
  required?: boolean;
}): void {
  const center = Reflect.get(args.metadata, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  if (!center || typeof center.writeRuntimeControl !== 'function') {
    if (args.required) {
      throw new Error('MetadataCenter runtime_control.stopless writer requires a bound MetadataCenter');
    }
    return;
  }
  writeBoundRuntimeControl({
    center,
    metadata: args.metadata,
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
  const center = Reflect.get(args.metadata, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  if (!center || typeof center.writeRuntimeControl !== 'function') {
    if (args.required) {
      throw new Error(`MetadataCenter runtime_control.${args.key} writer requires a bound MetadataCenter`);
    }
    return;
  }
  writeBoundRuntimeControl({
    center,
    metadata: args.metadata,
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
