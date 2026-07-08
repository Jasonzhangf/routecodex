// feature_id: hub.metadata_center_dualwrite_api
import type {
  MetadataCenterCloseoutStatus,
  MetadataCenterContinuationContext,
  MetadataCenterDebugSnapshot,
  MetadataCenterFamily,
  MetadataCenterProviderObservation,
  MetadataCenterResponseObservation,
  MetadataCenterRequestTruth,
  MetadataCenterRuntimeControl,
  MetadataCenterWriter
} from './metadata-center-types.js';
import { MetadataCenter } from './metadata-center.js';

const RUST_SNAPSHOT_SYMBOL = Symbol.for('routecodex.metadataCenter.rustSnapshot');

type FamilyPayload = {
  request_truth: MetadataCenterRequestTruth;
  continuation_context: MetadataCenterContinuationContext;
  runtime_control: MetadataCenterRuntimeControl;
  provider_observation: MetadataCenterProviderObservation;
  response_observation: MetadataCenterResponseObservation;
  closeout_status: MetadataCenterCloseoutStatus;
  debug_snapshot: MetadataCenterDebugSnapshot;
};

type CamelFamilyName = 'requestTruth'
  | 'continuationContext'
  | 'runtimeControl'
  | 'providerObservation'
  | 'responseObservation'
  | 'closeoutStatus'
  | 'debugSnapshot';

const CAMEL_FAMILY: Record<MetadataCenterFamily, CamelFamilyName> = {
  request_truth: 'requestTruth',
  continuation_context: 'continuationContext',
  runtime_control: 'runtimeControl',
  provider_observation: 'providerObservation',
  response_observation: 'responseObservation',
  closeout_status: 'closeoutStatus',
  debug_snapshot: 'debugSnapshot'
};

export type MetadataCenterDualWriteInput = {
  target: Record<string, unknown>;
  family: MetadataCenterFamily;
  key: string;
  value: unknown;
  writer: MetadataCenterWriter;
  reason?: string;
  expectedScope?: MetadataCenterScope;
};

export type MetadataCenterReleaseInput = {
  target: Record<string, unknown>;
  family: MetadataCenterFamily;
  key: string;
  writer: MetadataCenterWriter;
  reason?: string;
  expectedScope?: MetadataCenterScope;
};

export type MetadataCenterScope = {
  requestId?: string;
  sessionId?: string;
};

export type MetadataCenterRustSnapshot = {
  requestTruth?: MetadataCenterRequestTruth;
  continuationContext?: MetadataCenterContinuationContext;
  runtimeControl?: MetadataCenterRuntimeControl;
  providerObservation?: MetadataCenterProviderObservation;
  responseObservation?: MetadataCenterResponseObservation;
  closeoutStatus?: MetadataCenterCloseoutStatus;
  debugSnapshot?: MetadataCenterDebugSnapshot;
};

export type MetadataCenterDualWriteEnvelope = {
  snapshot: MetadataCenterRustSnapshot;
  writtenFamilies: MetadataCenterFamily[];
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function readMetadataCenterRustMirror(target: Record<string, unknown>): MetadataCenterRustSnapshot {
  const current = Reflect.get(target, RUST_SNAPSHOT_SYMBOL);
  return asRecord(current) ? structuredClone(current) as MetadataCenterRustSnapshot : {};
}

export function bindMetadataCenterRustMirror(
  source: Record<string, unknown> | undefined,
  target: Record<string, unknown>
): void {
  if (!source) {
    return;
  }
  const snapshot = Reflect.get(source, RUST_SNAPSHOT_SYMBOL);
  if (asRecord(snapshot)) {
    Reflect.set(target, RUST_SNAPSHOT_SYMBOL, structuredClone(snapshot));
  }
}

function writeRustSnapshot(target: Record<string, unknown>, snapshot: MetadataCenterRustSnapshot): void {
  Reflect.set(target, RUST_SNAPSHOT_SYMBOL, structuredClone(snapshot));
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function assertMetadataCenterScope(args: {
  source: Record<string, unknown>;
  expectedScope?: MetadataCenterScope;
  operation: string;
}): void {
  const expectedRequestId = readTrimmedString(args.expectedScope?.requestId);
  const expectedSessionId = readTrimmedString(args.expectedScope?.sessionId);
  if (!expectedRequestId && !expectedSessionId) {
    return;
  }

  const centerTruth = MetadataCenter.read(args.source)?.readRequestTruth() ?? {};
  const rustTruth = readMetadataCenterRustMirror(args.source).requestTruth ?? {};
  const actualRequestId = readTrimmedString(rustTruth.requestId) ?? readTrimmedString(centerTruth.requestId);
  const actualSessionId = readTrimmedString(rustTruth.sessionId) ?? readTrimmedString(centerTruth.sessionId);

  if (expectedRequestId && actualRequestId !== expectedRequestId) {
    throw new Error(
      `MetadataCenter ${args.operation} scope mismatch: requestId expected=${expectedRequestId} actual=${actualRequestId ?? '<missing>'}`
    );
  }
  if (expectedSessionId && actualSessionId !== expectedSessionId) {
    throw new Error(
      `MetadataCenter ${args.operation} scope mismatch: sessionId expected=${expectedSessionId} actual=${actualSessionId ?? '<missing>'}`
    );
  }
}

function writeJsMirror(input: MetadataCenterDualWriteInput): void {
  const center = MetadataCenter.attach(input.target);
  switch (input.family) {
    case 'request_truth':
      center.writeRequestTruth(
        input.key as keyof MetadataCenterRequestTruth,
        input.value as MetadataCenterRequestTruth[keyof MetadataCenterRequestTruth],
        input.writer,
        input.reason
      );
      return;
    case 'continuation_context':
      center.writeContinuationContext(
        input.key as keyof MetadataCenterContinuationContext,
        input.value as MetadataCenterContinuationContext[keyof MetadataCenterContinuationContext],
        input.writer,
        input.reason
      );
      return;
    case 'runtime_control':
      center.writeRuntimeControl(
        input.key as keyof MetadataCenterRuntimeControl,
        input.value as MetadataCenterRuntimeControl[keyof MetadataCenterRuntimeControl],
        input.writer,
        input.reason
      );
      return;
    case 'provider_observation':
      center.writeProviderObservation(
        input.key as keyof MetadataCenterProviderObservation,
        input.value as MetadataCenterProviderObservation[keyof MetadataCenterProviderObservation],
        input.writer,
        input.reason
      );
      return;
    case 'response_observation':
      center.writeResponseObservation(
        input.key as keyof MetadataCenterResponseObservation,
        input.value as MetadataCenterResponseObservation[keyof MetadataCenterResponseObservation],
        input.writer,
        input.reason
      );
      return;
    case 'closeout_status':
      center.writeCloseoutStatus(
        input.key as keyof MetadataCenterCloseoutStatus,
        input.value as MetadataCenterCloseoutStatus[keyof MetadataCenterCloseoutStatus],
        input.writer,
        input.reason
      );
      return;
    case 'debug_snapshot':
      center.writeDebugSnapshot(
        input.key as keyof MetadataCenterDebugSnapshot,
        input.value as MetadataCenterDebugSnapshot[keyof MetadataCenterDebugSnapshot],
        input.writer,
        input.reason
      );
      return;
  }
}

function writeRustMirror(input: MetadataCenterDualWriteInput): void {
  const snapshot = readMetadataCenterRustMirror(input.target);
  const family = CAMEL_FAMILY[input.family];
  const row = asRecord(snapshot[family]) ?? {};
  row[input.key] = structuredClone(input.value);
  (snapshot as Record<string, unknown>)[family] = row;
  writeRustSnapshot(input.target, snapshot);
}

function releaseJsMirror(input: MetadataCenterReleaseInput): void {
  const center = MetadataCenter.read(input.target);
  if (!center) {
    return;
  }
  switch (input.family) {
    case 'runtime_control':
      center.releaseRuntimeControl(
        input.key as keyof MetadataCenterRuntimeControl,
        input.writer,
        input.reason
      );
      return;
    case 'request_truth':
    case 'continuation_context':
    case 'provider_observation':
    case 'response_observation':
    case 'closeout_status':
    case 'debug_snapshot':
      throw new Error(`MetadataCenter release ${input.family}.${input.key} is not supported`);
  }
}

function releaseRustMirror(input: MetadataCenterReleaseInput): void {
  const snapshot = readMetadataCenterRustMirror(input.target);
  const family = CAMEL_FAMILY[input.family];
  const row = asRecord(snapshot[family]);
  if (!row || !Object.prototype.hasOwnProperty.call(row, input.key)) {
    return;
  }
  delete row[input.key];
  (snapshot as Record<string, unknown>)[family] = row;
  writeRustSnapshot(input.target, snapshot);
}

export function writeMetadataCenterSlot(input: MetadataCenterDualWriteInput): void {
  if (input.family !== 'request_truth') {
    assertMetadataCenterScope({
      source: input.target,
      expectedScope: input.expectedScope,
      operation: `write ${input.family}.${input.key}`
    });
  }
  writeJsMirror(input);
  writeRustMirror(input);
}

export function releaseMetadataCenterSlot(input: MetadataCenterReleaseInput): void {
  if (input.family !== 'request_truth') {
    assertMetadataCenterScope({
      source: input.target,
      expectedScope: input.expectedScope,
      operation: `release ${input.family}.${input.key}`
    });
  }
  releaseJsMirror(input);
  releaseRustMirror(input);
}

export function readMetadataCenterSlot(_input: {
  source: Record<string, unknown>;
  family: MetadataCenterFamily;
  key: string;
  expectedScope?: MetadataCenterScope;
}): unknown {
  assertMetadataCenterScope({
    source: _input.source,
    expectedScope: _input.expectedScope,
    operation: `read ${_input.family}.${_input.key}`
  });
  const snapshot = buildMetadataCenterRustSnapshot(_input.source);
  const family = CAMEL_FAMILY[_input.family];
  const rustValue = asRecord(snapshot[family])?.[_input.key];
  if (rustValue !== undefined) {
    return rustValue;
  }
  const center = MetadataCenter.read(_input.source);
  if (!center) {
    return undefined;
  }
  switch (_input.family) {
    case 'request_truth':
      return center.readRequestTruth()[_input.key as keyof MetadataCenterRequestTruth];
    case 'continuation_context':
      return center.readContinuationContext()[_input.key as keyof MetadataCenterContinuationContext];
    case 'runtime_control':
      return center.readRuntimeControl()[_input.key as keyof MetadataCenterRuntimeControl];
    case 'provider_observation':
      return center.readProviderObservation()[_input.key as keyof MetadataCenterProviderObservation];
    case 'response_observation':
      return center.readResponseObservation()[_input.key as keyof MetadataCenterResponseObservation];
    case 'closeout_status':
      return center.readCloseoutStatus()[_input.key as keyof MetadataCenterCloseoutStatus];
    case 'debug_snapshot':
      return center.readDebugSnapshot()[_input.key as keyof MetadataCenterDebugSnapshot];
  }
}

export function buildMetadataCenterRustSnapshot(source: Record<string, unknown>): MetadataCenterRustSnapshot {
  const rustSnapshot = readMetadataCenterRustMirror(source);
  const center = MetadataCenter.read(source);
  if (!center) {
    return rustSnapshot;
  }
  return {
    requestTruth: {
      ...center.readRequestTruth(),
      ...(rustSnapshot.requestTruth ?? {})
    },
    continuationContext: {
      ...center.readContinuationContext(),
      ...(rustSnapshot.continuationContext ?? {})
    },
    runtimeControl: {
      ...center.readRuntimeControl(),
      ...(rustSnapshot.runtimeControl ?? {})
    },
    providerObservation: {
      ...center.readProviderObservation(),
      ...(rustSnapshot.providerObservation ?? {})
    },
    responseObservation: {
      ...center.readResponseObservation(),
      ...(rustSnapshot.responseObservation ?? {})
    },
    closeoutStatus: {
      ...center.readCloseoutStatus(),
      ...(rustSnapshot.closeoutStatus ?? {})
    },
    debugSnapshot: {
      ...center.readDebugSnapshot(),
      ...(rustSnapshot.debugSnapshot ?? {})
    }
  };
}

const TRANSPORT_SNAPSHOT_FAMILIES = [
  'requestTruth',
  'continuationContext',
  'runtimeControl',
  'providerObservation',
  'responseObservation',
  'closeoutStatus',
  'debugSnapshot'
] as const;

function hasEntries(value: Record<string, unknown> | undefined): value is Record<string, unknown> {
  return Boolean(value && Object.keys(value).length > 0);
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

export function buildMetadataCenterTransportSnapshot(
  source: Record<string, unknown>
): Record<string, unknown> | undefined {
  const existingSnapshot = asRecord(source.metadataCenterSnapshot);
  const rustSnapshot = buildMetadataCenterRustSnapshot(source) as Record<string, unknown>;
  const snapshot: Record<string, unknown> = {};

  for (const family of TRANSPORT_SNAPSHOT_FAMILIES) {
    const existingFamily = asRecord(existingSnapshot?.[family]);
    const rustFamily = asRecord(rustSnapshot[family]);
    const mergedFamily = {
      ...(existingFamily ?? {}),
      ...(rustFamily ?? {})
    };
    if (hasEntries(mergedFamily)) {
      snapshot[family] = mergedFamily;
    }
  }

  const excludedProviderKeys = readStringList(source.excludedProviderKeys);
  const existingExcludedProviderKeys = readStringList(existingSnapshot?.excludedProviderKeys);
  const effectiveExcludedProviderKeys =
    excludedProviderKeys.length > 0 ? excludedProviderKeys : existingExcludedProviderKeys;
  if (effectiveExcludedProviderKeys.length > 0) {
    snapshot.excludedProviderKeys = effectiveExcludedProviderKeys;
  }

  return hasEntries(snapshot) ? snapshot : undefined;
}

export function applyMetadataCenterRustWriteResult(args: {
  target: Record<string, unknown>;
  snapshot: MetadataCenterRustSnapshot;
  writer?: MetadataCenterWriter;
  reason?: string;
}): void {
  const writer = args.writer ?? {
    module: 'src/server/runtime/http-server/metadata-center/dualwrite-api.ts',
    symbol: 'applyMetadataCenterRustWriteResult',
    stage: 'metadata_center_dualwrite'
  };
  for (const [family, camelFamily] of Object.entries(CAMEL_FAMILY) as Array<[MetadataCenterFamily, CamelFamilyName]>) {
    const row = asRecord(args.snapshot[camelFamily]);
    if (!row) {
      continue;
    }
    for (const [key, value] of Object.entries(row)) {
      const currentValue = readMetadataCenterSlot({
        source: args.target,
        family,
        key
      });
      if (currentValue !== undefined && JSON.stringify(currentValue) === JSON.stringify(value)) {
        continue;
      }
      writeMetadataCenterSlot({
        target: args.target,
        family,
        key,
        value,
        writer,
        reason: args.reason ?? 'rust metadata center write result'
      });
    }
  }
  writeRustSnapshot(args.target, args.snapshot);
}
