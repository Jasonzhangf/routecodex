import {
  buildProviderResponseMetadataSnapshotWithNative,
  ensureRuntimeMetadataWithNative,
} from './provider-response-native-calls.js';

type JsonObject = Record<string, unknown>;
type RuntimeControlWriter = { module: string; symbol: string; stage: string };

export type MetadataCenterLike = {
  writeRuntimeControl?: (
    key: string,
    value: unknown,
    writtenBy: RuntimeControlWriter,
    reason?: string,
  ) => void;
  readRuntimeControl?: () => Record<string, unknown>;
  readRequestTruth?: () => Record<string, unknown>;
  readContinuationContext?: () => Record<string, unknown>;
  readProviderObservation?: () => Record<string, unknown>;
};

export const METADATA_CENTER_SYMBOL = Symbol.for('routecodex.metadataCenter');
export const RUST_SNAPSHOT_SYMBOL = Symbol.for('routecodex.metadataCenter.rustSnapshot');

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value as Record<string, unknown> : undefined;
}

export function ensureRuntimeMetadata(carrier: Record<string, unknown>): JsonObject {
  const nextCarrier = ensureRuntimeMetadataWithNative(carrier);
  const directCenter = Reflect.get(carrier, METADATA_CENTER_SYMBOL);
  const rustSnapshot = Reflect.get(carrier, RUST_SNAPSHOT_SYMBOL);
  Object.assign(carrier, nextCarrier);
  const existing = carrier.__rt;
  if (directCenter !== undefined) {
    Reflect.set(carrier, METADATA_CENTER_SYMBOL, directCenter);
  }
  if (rustSnapshot !== undefined) {
    Reflect.set(carrier, RUST_SNAPSHOT_SYMBOL, rustSnapshot);
  }
  if (isRecord(existing)) {
    return existing as JsonObject;
  }
  carrier.__rt = {};
  return carrier.__rt as JsonObject;
}

export function readBoundMetadataCenter(target: Record<string, unknown>): MetadataCenterLike | undefined {
  const directCenter = Reflect.get(target, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  if (directCenter && typeof directCenter.writeRuntimeControl === 'function') {
    return directCenter;
  }
  const nested = asRecord(target.metadata);
  if (!nested) {
    return undefined;
  }
  const nestedCenter = Reflect.get(nested, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  return nestedCenter && typeof nestedCenter.writeRuntimeControl === 'function'
    ? nestedCenter
    : undefined;
}

export function readRuntimeControlFromBoundMetadataCenter(target: Record<string, unknown>): Record<string, unknown> {
  const runtimeControl = readBoundMetadataCenter(target)?.readRuntimeControl?.();
  return isRecord(runtimeControl) ? { ...runtimeControl } : {};
}

export function readRequestTruthFromBoundMetadataCenter(target: Record<string, unknown>): Record<string, unknown> {
  const requestTruth = readBoundMetadataCenter(target)?.readRequestTruth?.();
  return isRecord(requestTruth) ? { ...requestTruth } : {};
}

export function readContinuationContextFromBoundMetadataCenter(target: Record<string, unknown>): Record<string, unknown> {
  const continuationContext = readBoundMetadataCenter(target)?.readContinuationContext?.();
  return isRecord(continuationContext) ? { ...continuationContext } : {};
}

function writeMetadataCenterRuntimeControl(args: {
  target: Record<string, unknown>;
  center: MetadataCenterLike;
  key: string;
  value: unknown;
  writer: RuntimeControlWriter;
  reason: string;
}): void {
  args.center.writeRuntimeControl?.(args.key, args.value, args.writer, args.reason);
  const currentSnapshot = asRecord(Reflect.get(args.target, RUST_SNAPSHOT_SYMBOL));
  const nextSnapshot = currentSnapshot ? { ...currentSnapshot } : {};
  const runtimeControl = asRecord(nextSnapshot.runtimeControl) ?? {};
  runtimeControl[args.key] = structuredClone(args.value);
  nextSnapshot.runtimeControl = runtimeControl;
  Reflect.set(args.target, RUST_SNAPSHOT_SYMBOL, nextSnapshot);
}

export function applyNativeRuntimeControlWritePlan(args: {
  metadata: Record<string, unknown>;
  runtimeControl: Record<string, unknown>;
  writer: RuntimeControlWriter;
  reason: string;
}): void {
  const directCenter = Reflect.get(args.metadata, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  const nestedMetadata = asRecord(args.metadata.metadata);
  const nestedCenter = nestedMetadata
    ? Reflect.get(nestedMetadata, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined
    : undefined;
  const bound = directCenter && typeof directCenter.writeRuntimeControl === 'function'
    ? { target: args.metadata, center: directCenter }
    : nestedCenter && typeof nestedCenter.writeRuntimeControl === 'function' && nestedMetadata
      ? { target: nestedMetadata, center: nestedCenter }
      : undefined;
  if (!bound) {
    throw new Error('MetadataCenter runtime_control write failed: bound MetadataCenter missing');
  }
  for (const [key, value] of Object.entries(args.runtimeControl)) {
    if (value === undefined) {
      continue;
    }
    writeMetadataCenterRuntimeControl({
      target: bound.target,
      center: bound.center,
      key,
      value,
      writer: args.writer,
      reason: args.reason,
    });
  }
}

export function readMetadataCenterSnapshotForRust(context: Record<string, unknown>): Record<string, unknown> | null {
  const direct = asRecord(context.metadataCenterSnapshot);
  const nestedMetadata = asRecord(context.metadata);
  const snapshotPlan = buildProviderResponseMetadataSnapshotWithNative({
    hasBoundMetadataCenter: Boolean(readBoundMetadataCenter(context)),
    requestTruth: readRequestTruthFromBoundMetadataCenter(context),
    continuationContext: readContinuationContextFromBoundMetadataCenter(context),
    runtimeControl: readRuntimeControlFromBoundMetadataCenter(context),
    directMetadataCenterSnapshot: direct ?? null,
    nestedMetadataCenterSnapshot: nestedMetadata ? asRecord(nestedMetadata.metadataCenterSnapshot) ?? null : null,
  });
  return snapshotPlan.metadataCenterSnapshot ?? null;
}

export function writeRustStopGatewayContextToMetadataCenter(args: {
  metadata: Record<string, unknown>;
  stopGatewayContext: Record<string, unknown>;
  writer: RuntimeControlWriter;
  reason: string;
}): void {
  applyNativeRuntimeControlWritePlan({
    metadata: args.metadata,
    runtimeControl: { stopGatewayContext: args.stopGatewayContext },
    writer: args.writer,
    reason: args.reason,
  });
  ensureRuntimeMetadata(args.metadata).stopGatewayContext = args.stopGatewayContext as JsonObject;
}
