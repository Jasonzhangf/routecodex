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
