import type { JsonObject } from '../conversion/hub/types/json.js';

const METADATA_CENTER_SYMBOL = Symbol.for('routecodex.metadataCenter');

type RuntimeControlWriter = {
  module: string;
  symbol: string;
  stage: string;
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

function writeBoundRuntimeControl(args: {
  center: MetadataCenterLike;
  key: string;
  value: unknown;
  writer: RuntimeControlWriter;
  reason?: string;
}): void {
  args.center.writeRuntimeControl?.(args.key, args.value, args.writer, args.reason);
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

export function readRequestTruthFromAnyBoundMetadataCenter(
  target: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!target) {
    return undefined;
  }
  const directCenter = Reflect.get(target, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  if (directCenter && typeof directCenter.readRequestTruth === 'function') {
    const requestTruth = directCenter.readRequestTruth();
    return requestTruth && typeof requestTruth === 'object' && !Array.isArray(requestTruth)
      ? requestTruth
      : undefined;
  }
  const metadata = asRecord(target.metadata);
  return metadata ? readRequestTruthFromAnyBoundMetadataCenter(metadata) : undefined;
}

export function readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter(
  target: Record<string, unknown> | undefined
): JsonObject | undefined {
  const runtimeControl = readRuntimeControlFromAnyBoundMetadataCenter(target);
  const requestTruth = readRequestTruthFromAnyBoundMetadataCenter(target);
  if (!runtimeControl && !requestTruth) {
    return undefined;
  }
  return {
    metadataCenterSnapshot: {
      requestTruth: (requestTruth ?? {}) as JsonObject,
      runtimeControl: (runtimeControl ?? {}) as JsonObject
    }
  };
}
