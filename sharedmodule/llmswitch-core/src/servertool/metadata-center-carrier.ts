import type { JsonObject } from '../conversion/hub/types/json.js';
import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import {
  inspectStopGatewaySignalWithNative,
  normalizeStopMessageCompareContextWithNative,
  type StopGatewayContext,
  type StopMessageCompareContext
} from '../native/router-hotpath/native-servertool-core-semantics.js';

const METADATA_CENTER_SYMBOL = Symbol.for('routecodex.metadataCenter');
const RUST_SNAPSHOT_SYMBOL = Symbol.for('routecodex.metadataCenter.rustSnapshot');

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
  readProviderObservation?: () => Record<string, unknown> | undefined;
};

type BoundMetadataCenterTarget = {
  target: Record<string, unknown>;
  center: MetadataCenterLike;
};

const STOP_GATEWAY_CONTEXT_WRITER = {
  module: 'sharedmodule/llmswitch-core/src/servertool/metadata-center-carrier.ts',
  symbol: 'attachStopGatewayContext',
  stage: 'HubRespChatProcess03Governed'
} as const;

const STOP_MESSAGE_COMPARE_KEY = 'stopMessageCompareContext';
const STOP_MESSAGE_COMPARE_WRITER = {
  module: 'sharedmodule/llmswitch-core/src/servertool/metadata-center-carrier.ts',
  symbol: 'attachStopMessageCompareContext',
  stage: 'HubRespChatProcess03Governed'
} as const;

export type { StopGatewayContext, StopMessageCompareContext };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readBoundMetadataCenterTarget(metadata: Record<string, unknown>): BoundMetadataCenterTarget | undefined {
  const directCenter = Reflect.get(metadata, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  if (directCenter && typeof directCenter.writeRuntimeControl === 'function') {
    return { target: metadata, center: directCenter };
  }
  const nestedMetadata = asRecord(metadata.metadata);
  const nestedCenter = nestedMetadata
    ? (Reflect.get(nestedMetadata, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined)
    : undefined;
  if (nestedMetadata && nestedCenter && typeof nestedCenter.writeRuntimeControl === 'function') {
    return { target: nestedMetadata, center: nestedCenter };
  }
  return undefined;
}

function writeMetadataCenterSlot(args: {
  target: Record<string, unknown>;
  center: MetadataCenterLike;
  family: 'runtime_control';
  key: string;
  value: unknown;
  writer: RuntimeControlWriter;
  reason?: string;
}): void {
  if (args.family !== 'runtime_control') {
    throw new Error(`MetadataCenter unsupported family for servertool carrier: ${args.family}`);
  }
  args.center.writeRuntimeControl?.(args.key, args.value, args.writer, args.reason);
  const currentSnapshot = asRecord(Reflect.get(args.target, RUST_SNAPSHOT_SYMBOL));
  const nextSnapshot = currentSnapshot ? { ...currentSnapshot } : {};
  const runtimeControl = asRecord(nextSnapshot.runtimeControl) ?? {};
  runtimeControl[args.key] = structuredClone(args.value);
  nextSnapshot.runtimeControl = runtimeControl;
  Reflect.set(args.target, RUST_SNAPSHOT_SYMBOL, nextSnapshot);
}

export function writeRuntimeControlToBoundMetadataCenter(args: {
  metadata: Record<string, unknown>;
  key: string;
  value: unknown;
  writer: RuntimeControlWriter;
  reason?: string;
  required?: boolean;
}): void {
  const bound = readBoundMetadataCenterTarget(args.metadata);
  if (!bound) {
    if (args.required) {
      throw new Error(`MetadataCenter runtime_control.${args.key} writer requires a bound MetadataCenter`);
    }
    return;
  }
  writeMetadataCenterSlot({
    target: bound.target,
    center: bound.center,
    family: 'runtime_control',
    key: args.key,
    value: args.value,
    writer: args.writer,
    reason: args.reason,
  });
}

function readRuntimeControlFromBoundMetadataCenter(
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
  return runtimeControl != null && typeof runtimeControl === 'object' && !Array.isArray(runtimeControl)
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

function readRequestTruthSessionIdFromBoundMetadataCenter(
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

function readRequestTruthSessionIdFromAnyBoundMetadataCenter(
  target: Record<string, unknown> | undefined
): string | undefined {
  const direct = readRequestTruthSessionIdFromBoundMetadataCenter(target);
  if (direct) {
    return direct;
  }
  const metadata = asRecord(target?.metadata);
  return readRequestTruthSessionIdFromBoundMetadataCenter(metadata);
}

function readRequestTruthFromAnyBoundMetadataCenter(
  target: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!target) {
    return undefined;
  }
  const directCenter = Reflect.get(target, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  if (directCenter && typeof directCenter.readRequestTruth === 'function') {
    const requestTruth = directCenter.readRequestTruth();
    return requestTruth != null && typeof requestTruth === 'object' && !Array.isArray(requestTruth)
      ? requestTruth
      : undefined;
  }
  const metadata = asRecord(target.metadata);
  return metadata ? readRequestTruthFromAnyBoundMetadataCenter(metadata) : undefined;
}

function readProviderObservationFromAnyBoundMetadataCenter(
  target: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!target) {
    return undefined;
  }
  const directCenter = Reflect.get(target, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  if (directCenter && typeof directCenter.readProviderObservation === 'function') {
    const providerObservation = directCenter.readProviderObservation();
    return providerObservation != null && typeof providerObservation === 'object' && !Array.isArray(providerObservation)
      ? providerObservation
      : undefined;
  }
  const metadata = asRecord(target.metadata);
  return metadata ? readProviderObservationFromAnyBoundMetadataCenter(metadata) : undefined;
}

export function readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter(
  target: Record<string, unknown> | undefined
): JsonObject | undefined {
  const runtimeControl = readRuntimeControlFromAnyBoundMetadataCenter(target);
  const requestTruth = readRequestTruthFromAnyBoundMetadataCenter(target);
  const providerObservation = readProviderObservationFromAnyBoundMetadataCenter(target);
  if (!runtimeControl && !requestTruth && !providerObservation) {
    return undefined;
  }
  return {
    metadataCenterSnapshot: {
      requestTruth: (requestTruth ?? {}) as JsonObject,
      runtimeControl: (runtimeControl ?? {}) as JsonObject,
      providerObservation: (providerObservation ?? {}) as JsonObject
    }
  };
}

export function inspectStopGatewaySignal(base: unknown): StopGatewayContext {
  return inspectStopGatewaySignalWithNative(base);
}

export function attachStopGatewayContext(adapterContext: AdapterContext, context: StopGatewayContext): void {
  writeRuntimeControlToBoundMetadataCenter({
    metadata: adapterContext as unknown as Record<string, unknown>,
    key: 'stopGatewayContext',
    value: {
      observed: context.observed,
      eligible: context.eligible,
      source: context.source,
      reason: context.reason,
      ...(typeof context.choiceIndex === 'number' ? { choiceIndex: context.choiceIndex } : {}),
      ...(typeof context.hasToolCalls === 'boolean' ? { hasToolCalls: context.hasToolCalls } : {})
    },
    writer: STOP_GATEWAY_CONTEXT_WRITER,
    reason: 'response stop gateway control signal',
    required: true
  });
}

export function attachStopMessageCompareContext(
  adapterContext: unknown,
  context: StopMessageCompareContext
): void {
  const normalized = normalizeStopMessageCompareContextWithNative(context);
  if (!normalized) {
    throw new Error('invalid stop-message compare context');
  }
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    throw new Error('MetadataCenter runtime_control.stopMessageCompareContext writer requires object carrier');
  }
  writeRuntimeControlToBoundMetadataCenter({
    metadata: adapterContext as Record<string, unknown>,
    key: STOP_MESSAGE_COMPARE_KEY,
    value: { ...normalized } as JsonObject,
    writer: STOP_MESSAGE_COMPARE_WRITER,
    reason: 'stop-message compare control signal',
    required: true
  });
}

export function readStopMessageCompareContext(adapterContext: unknown): StopMessageCompareContext | undefined {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return undefined;
  }
  const runtimeControl = readRuntimeControlFromAnyBoundMetadataCenter(adapterContext as Record<string, unknown>);
  const raw = runtimeControl?.[STOP_MESSAGE_COMPARE_KEY];
  return normalizeStopMessageCompareContextWithNative(raw);
}
