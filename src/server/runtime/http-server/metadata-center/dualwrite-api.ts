// feature_id: hub.metadata_center_dualwrite_api
import type {
  MetadataCenterClientAttachmentScope,
  MetadataCenterContinuationContext,
  MetadataCenterDebugSnapshot,
  MetadataCenterFamily,
  MetadataCenterProviderObservation,
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
  client_attachment_scope: MetadataCenterClientAttachmentScope;
  debug_snapshot: MetadataCenterDebugSnapshot;
};

type CamelFamilyName = 'requestTruth'
  | 'continuationContext'
  | 'runtimeControl'
  | 'providerObservation'
  | 'clientAttachmentScope'
  | 'debugSnapshot';

const CAMEL_FAMILY: Record<MetadataCenterFamily, CamelFamilyName> = {
  request_truth: 'requestTruth',
  continuation_context: 'continuationContext',
  runtime_control: 'runtimeControl',
  provider_observation: 'providerObservation',
  client_attachment_scope: 'clientAttachmentScope',
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

export type MetadataCenterScope = {
  requestId?: string;
  sessionId?: string;
};

export type MetadataCenterRustSnapshot = {
  requestTruth?: MetadataCenterRequestTruth;
  continuationContext?: MetadataCenterContinuationContext;
  runtimeControl?: MetadataCenterRuntimeControl;
  providerObservation?: MetadataCenterProviderObservation;
  clientAttachmentScope?: MetadataCenterClientAttachmentScope;
  debugSnapshot?: MetadataCenterDebugSnapshot;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readRustSnapshot(target: Record<string, unknown>): MetadataCenterRustSnapshot {
  const current = Reflect.get(target, RUST_SNAPSHOT_SYMBOL);
  return asRecord(current) ? structuredClone(current) as MetadataCenterRustSnapshot : {};
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
  const rustTruth = readRustSnapshot(args.source).requestTruth ?? {};
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
    case 'client_attachment_scope':
      center.writeClientAttachmentScope(
        input.key as keyof MetadataCenterClientAttachmentScope,
        input.value as MetadataCenterClientAttachmentScope[keyof MetadataCenterClientAttachmentScope],
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
  const snapshot = readRustSnapshot(input.target);
  const family = CAMEL_FAMILY[input.family];
  const row = asRecord(snapshot[family]) ?? {};
  row[input.key] = structuredClone(input.value);
  (snapshot as Record<string, unknown>)[family] = row;
  writeRustSnapshot(input.target, snapshot);
}

function writeMigrationMirrors(input: MetadataCenterDualWriteInput): void {
  if (input.family !== 'runtime_control' || input.key !== 'stopless') {
    return;
  }
  const stopless = asRecord(input.value);
  if (!stopless) {
    return;
  }
  const flowId = typeof stopless.flowId === 'string' ? stopless.flowId : undefined;
  const repeatCount = typeof stopless.repeatCount === 'number' ? stopless.repeatCount : undefined;
  const maxRepeats = typeof stopless.maxRepeats === 'number' ? stopless.maxRepeats : undefined;
  if (!flowId || repeatCount === undefined || maxRepeats === undefined) {
    return;
  }
  const loopState = {
    flowId,
    repeatCount,
    maxRepeats,
    ...(typeof stopless.triggerHint === 'string' ? { triggerHint: stopless.triggerHint } : {}),
    ...(asRecord(stopless.schemaFeedback) ? { schemaFeedback: asRecord(stopless.schemaFeedback) } : {})
  };
  writeMetadataCenterSlot({
    ...input,
    key: 'serverToolLoopState',
    value: loopState,
    reason: input.reason ? `${input.reason}:migration-serverToolLoopState` : 'migration-serverToolLoopState'
  });
  writeMetadataCenterSlot({
    ...input,
    key: 'stopMessageState',
    value: {
      stopMessageText: typeof stopless.continuationPrompt === 'string'
        ? stopless.continuationPrompt
        : '继续执行',
      stopMessageMaxRepeats: maxRepeats,
      stopMessageUsed: repeatCount,
      stopMessageStageMode: 'on'
    },
    reason: input.reason ? `${input.reason}:migration-stopMessageState` : 'migration-stopMessageState'
  });
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
  writeMigrationMirrors(input);
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
    case 'client_attachment_scope':
      return center.readClientAttachmentScope()[_input.key as keyof MetadataCenterClientAttachmentScope];
    case 'debug_snapshot':
      return center.readDebugSnapshot()[_input.key as keyof MetadataCenterDebugSnapshot];
  }
}

export function buildMetadataCenterRustSnapshot(source: Record<string, unknown>): MetadataCenterRustSnapshot {
  const rustSnapshot = readRustSnapshot(source);
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
    clientAttachmentScope: {
      ...center.readClientAttachmentScope(),
      ...(rustSnapshot.clientAttachmentScope ?? {})
    },
    debugSnapshot: {
      ...center.readDebugSnapshot(),
      ...(rustSnapshot.debugSnapshot ?? {})
    }
  };
}

export function applyMetadataCenterRustWriteResult(args: {
  target: Record<string, unknown>;
  snapshot: MetadataCenterRustSnapshot;
}): void {
  writeRustSnapshot(args.target, args.snapshot);
}
