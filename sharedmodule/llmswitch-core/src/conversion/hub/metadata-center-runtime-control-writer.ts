import {
  projectMetadataWritePlanToRuntimeControlWithNative,
  projectMetadataWritePlanToRuntimeControlWritePlanWithNative
} from '../../native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.js';

const METADATA_CENTER_SYMBOL = Symbol.for('routecodex.metadataCenter');
const RUST_SNAPSHOT_SYMBOL = Symbol.for('routecodex.metadataCenter.rustSnapshot');

export { METADATA_CENTER_SYMBOL, RUST_SNAPSHOT_SYMBOL };

type RuntimeControlWriter = {
  module: string;
  symbol: string;
  stage: string;
};

export type MetadataCenterLike = {
  writeRuntimeControl?: (
    key: string,
    value: unknown,
    writtenBy: RuntimeControlWriter,
    reason?: string
  ) => void;
  readRuntimeControl?: () => Record<string, unknown>;
  readRequestTruth?: () => Record<string, unknown>;
  readContinuationContext?: () => Record<string, unknown>;
  readProviderObservation?: () => Record<string, unknown>;
};

type BoundMetadataCenterTarget = {
  target: Record<string, unknown>;
  center: MetadataCenterLike;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readBoundMetadataCenterTarget(target: Record<string, unknown>): BoundMetadataCenterTarget | undefined {
  const direct = Reflect.get(target, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  if (direct && typeof direct.writeRuntimeControl === 'function') {
    return { target, center: direct };
  }
  const nested = asRecord(target.metadata);
  if (nested) {
    const nestedCenter = Reflect.get(nested, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
    if (nestedCenter && typeof nestedCenter.writeRuntimeControl === 'function') {
      return { target: nested, center: nestedCenter };
    }
  }
  return undefined;
}

export function readBoundMetadataCenter(target: Record<string, unknown>): MetadataCenterLike | undefined {
  return readBoundMetadataCenterTarget(target)?.center;
}

export function readRuntimeControlFromBoundMetadataCenter(
  target: Record<string, unknown>
): Record<string, unknown> {
  const center = readBoundMetadataCenter(target);
  if (center && typeof center.readRuntimeControl === 'function') {
    const rc = center.readRuntimeControl();
    if (rc && typeof rc === 'object' && !Array.isArray(rc)) {
      return { ...rc };
    }
  }
  return {};
}

export function readRequestTruthFromBoundMetadataCenter(
  target: Record<string, unknown>
): Record<string, unknown> {
  const center = readBoundMetadataCenter(target);
  if (center && typeof center.readRequestTruth === 'function') {
    const rt = center.readRequestTruth();
    if (rt && typeof rt === 'object' && !Array.isArray(rt)) {
      return { ...rt };
    }
  }
  return {};
}

export function readContinuationContextFromBoundMetadataCenter(
  target: Record<string, unknown>
): Record<string, unknown> {
  const center = readBoundMetadataCenter(target);
  if (center && typeof center.readContinuationContext === 'function') {
    const cc = center.readContinuationContext();
    if (cc && typeof cc === 'object' && !Array.isArray(cc)) {
      return { ...cc };
    }
  }
  return {};
}

function readRuntimeControlFromDirectBoundMetadataCenter(
  target: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!target) {
    return undefined;
  }
  const center = Reflect.get(target, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  if (!center || typeof center.readRuntimeControl !== 'function') {
    return undefined;
  }
  const runtimeControl = center.readRuntimeControl();
  return runtimeControl && typeof runtimeControl === 'object' && !Array.isArray(runtimeControl)
    ? { ...runtimeControl }
    : undefined;
}

export function readRuntimeControlFromAnyBoundMetadataCenter(
  target: unknown
): Record<string, unknown> | undefined {
  const targetRecord = asRecord(target);
  const direct = readRuntimeControlFromDirectBoundMetadataCenter(targetRecord);
  if (direct) {
    return direct;
  }
  const metadata = asRecord(targetRecord?.metadata);
  return readRuntimeControlFromDirectBoundMetadataCenter(metadata);
}

function readRequestTruthFromAnyBoundMetadataCenter(
  target: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!target) {
    return undefined;
  }
  const center = Reflect.get(target, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  if (center && typeof center.readRequestTruth === 'function') {
    const requestTruth = center.readRequestTruth();
    return requestTruth && typeof requestTruth === 'object' && !Array.isArray(requestTruth)
      ? { ...requestTruth }
      : undefined;
  }
  const metadata = asRecord(target.metadata);
  return metadata ? readRequestTruthFromAnyBoundMetadataCenter(metadata) : undefined;
}

function readContinuationContextFromAnyBoundMetadataCenter(
  target: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!target) {
    return undefined;
  }
  const center = Reflect.get(target, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  if (center && typeof center.readContinuationContext === 'function') {
    const continuationContext = center.readContinuationContext();
    return continuationContext && typeof continuationContext === 'object' && !Array.isArray(continuationContext)
      ? { ...continuationContext }
      : undefined;
  }
  const metadata = asRecord(target.metadata);
  return metadata ? readContinuationContextFromAnyBoundMetadataCenter(metadata) : undefined;
}

function readProviderObservationFromAnyBoundMetadataCenter(
  target: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!target) {
    return undefined;
  }
  const center = Reflect.get(target, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  if (center && typeof center.readProviderObservation === 'function') {
    const providerObservation = center.readProviderObservation();
    return providerObservation && typeof providerObservation === 'object' && !Array.isArray(providerObservation)
      ? { ...providerObservation }
      : undefined;
  }
  const metadata = asRecord(target.metadata);
  return metadata ? readProviderObservationFromAnyBoundMetadataCenter(metadata) : undefined;
}

export function readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter(
  target: unknown
): { metadataCenterSnapshot: Record<string, unknown> } | undefined {
  const targetRecord = asRecord(target);
  const runtimeControl = readRuntimeControlFromAnyBoundMetadataCenter(targetRecord);
  const requestTruth = readRequestTruthFromAnyBoundMetadataCenter(targetRecord);
  const continuationContext = readContinuationContextFromAnyBoundMetadataCenter(targetRecord);
  const providerObservation = readProviderObservationFromAnyBoundMetadataCenter(targetRecord);
  if (!runtimeControl && !requestTruth && !continuationContext && !providerObservation) {
    return undefined;
  }
  return {
    metadataCenterSnapshot: {
      requestTruth: requestTruth ?? {},
      continuationContext: continuationContext ?? {},
      runtimeControl: runtimeControl ?? {},
      providerObservation: providerObservation ?? {}
    }
  };
}

function writeMetadataCenterSlot(args: {
  target: Record<string, unknown>;
  center: MetadataCenterLike;
  family: 'runtime_control';
  key: string;
  value: unknown;
  writer: RuntimeControlWriter;
  reason: string;
}): void {
  if (args.family !== 'runtime_control') {
    throw new Error(`MetadataCenter unsupported family for runtime-control writer: ${args.family}`);
  }
  args.center.writeRuntimeControl?.(args.key, args.value, args.writer, args.reason);
  const currentSnapshot = asRecord(Reflect.get(args.target, RUST_SNAPSHOT_SYMBOL));
  const nextSnapshot = currentSnapshot ? { ...currentSnapshot } : {};
  const runtimeControl = asRecord(nextSnapshot.runtimeControl) ?? {};
  runtimeControl[args.key] = structuredClone(args.value);
  nextSnapshot.runtimeControl = runtimeControl;
  Reflect.set(args.target, RUST_SNAPSHOT_SYMBOL, nextSnapshot);
}

export function applyNativeRuntimeControlWritePlan(args: {
  metadata: unknown;
  runtimeControl: Record<string, unknown>;
  writer: RuntimeControlWriter;
  reason: string;
}): void {
  const metadata = asRecord(args.metadata);
  const bound = metadata ? readBoundMetadataCenterTarget(metadata) : undefined;
  if (!bound) {
    throw new Error('MetadataCenter runtime_control write failed: bound MetadataCenter missing');
  }
  for (const [key, value] of Object.entries(args.runtimeControl)) {
    if (value === undefined) {
      continue;
    }
    writeMetadataCenterSlot({
      target: bound.target,
      center: bound.center,
      family: 'runtime_control',
      key,
      value,
      writer: args.writer,
      reason: args.reason,
    });
  }
}

export function projectNativeMetadataWritePlanToRuntimeControl(
  plan: Record<string, unknown>
): Record<string, unknown> {
  return projectMetadataWritePlanToRuntimeControlWithNative({ plan });
}

export function projectNativeMetadataWritePlanToRuntimeControlWritePlan(
  plan: Record<string, unknown>
): { runtimeControl?: Record<string, unknown> | null } {
  return projectMetadataWritePlanToRuntimeControlWritePlanWithNative({ plan });
}
