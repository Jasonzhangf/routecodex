import type {
  MetadataCenterCloseoutStatus,
  MetadataCenterContinuationContext,
  MetadataCenterDebugSnapshot,
  MetadataCenterFamily,
  MetadataCenterProviderObservation,
  MetadataCenterResponseObservation,
  MetadataCenterRequestTruth,
  MetadataCenterRuntimeControl,
  MetadataCenterSlot,
  MetadataCenterState,
  MetadataCenterStatus,
  MetadataCenterWritePolicy,
  MetadataCenterWriter
} from './metadata-center-types.js';

// feature_id: hub.metadata_center_mainline
const METADATA_CENTER_SYMBOL = Symbol.for('routecodex.metadataCenter');
const METADATA_CENTER_SESSION_BUFFER_SYMBOL = Symbol.for('routecodex.metadataCenter.sessionBuffer');
const METADATA_CENTER_SESSION_BUFFER_LIMIT = 10;

function now(): number {
  return Date.now();
}

function buildSlot<T>(args: {
  value: T;
  family: MetadataCenterFamily;
  writtenBy: MetadataCenterWriter;
  status?: MetadataCenterStatus;
  writePolicy: MetadataCenterWritePolicy;
  previous?: MetadataCenterSlot<T>;
  reason?: string;
}): MetadataCenterSlot<T> {
  return {
    value: args.value,
    family: args.family,
    writtenBy: args.writtenBy,
    status: args.status ?? 'active',
    writePolicy: args.writePolicy,
    version: (args.previous?.version ?? 0) + 1,
    history: [
      ...(args.previous?.history ?? []),
      {
        value: args.value,
        module: args.writtenBy.module,
        symbol: args.writtenBy.symbol,
        stage: args.writtenBy.stage,
        at: now(),
        ...(args.reason ? { reason: args.reason } : {})
      }
    ]
  };
}

const METADATA_CENTER_STATUS_ORDER: Readonly<Record<MetadataCenterStatus, number>> = {
  active: 0,
  consumed: 1,
  finalized: 2,
  released: 3,
};

const HTTP_RESPONSE_METADATA_RELEASE_WRITER: MetadataCenterWriter = {
  module: 'src/server/runtime/http-server/metadata-center/metadata-center.ts',
  symbol: 'releaseMetadataCenterForHttpResponse',
  stage: 'ServerRespOutbound05ClientFrame',
};

function bindInternalStateCarrier(target: Record<string, unknown>, center: MetadataCenter): void {
  Reflect.set(target, METADATA_CENTER_SYMBOL, center);
  target.__metadataCenter = center.snapshot() as unknown as Record<string, unknown>;
}

function transitionSlotStatus<T>(args: {
  previous: MetadataCenterSlot<T>;
  status: MetadataCenterStatus;
  changedBy: MetadataCenterWriter;
  reason?: string;
}): MetadataCenterSlot<T> {
  if (METADATA_CENTER_STATUS_ORDER[args.previous.status] >= METADATA_CENTER_STATUS_ORDER[args.status]) {
    return args.previous;
  }
  return {
    ...args.previous,
    status: args.status,
    version: args.previous.version + 1,
    history: [
      ...args.previous.history,
      {
        value: args.previous.value,
        module: args.changedBy.module,
        symbol: args.changedBy.symbol,
        stage: args.changedBy.stage,
        at: now(),
        reason: args.reason ?? `status:${args.status}`,
      },
    ],
  };
}

function isMetadataCenterLike(value: unknown): value is MetadataCenter {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as {
    readRequestTruth?: unknown;
    writeRequestTruth?: unknown;
    readRuntimeControl?: unknown;
    writeRuntimeControl?: unknown;
  };
  return (
    typeof candidate.readRequestTruth === 'function'
    && typeof candidate.writeRequestTruth === 'function'
    && typeof candidate.readRuntimeControl === 'function'
    && typeof candidate.writeRuntimeControl === 'function'
  );
}

export class MetadataCenter {
  private readonly state: MetadataCenterState;

  constructor() {
    this.state = {
      requestTruth: {},
      continuationContext: {},
      runtimeControl: {},
      providerObservation: {},
      responseObservation: {},
      closeoutStatus: {},
      debugSnapshot: {}
    };
  }

  static attach(target: Record<string, unknown>): MetadataCenter {
    const existing = Reflect.get(target, METADATA_CENTER_SYMBOL);
    if (isMetadataCenterLike(existing)) {
      bindInternalStateCarrier(target, existing);
      return existing;
    }
    const created = new MetadataCenter();
    bindInternalStateCarrier(target, created);
    return created;
  }

  static bind(target: Record<string, unknown>, center: MetadataCenter): void {
    bindInternalStateCarrier(target, center);
  }

  static read(target: Record<string, unknown> | undefined): MetadataCenter | undefined {
    if (!target) {
      return undefined;
    }
    const existing = Reflect.get(target, METADATA_CENTER_SYMBOL);
    return isMetadataCenterLike(existing) ? existing : undefined;
  }

  writeRequestTruth<K extends keyof MetadataCenterRequestTruth>(
    key: K,
    value: MetadataCenterRequestTruth[K],
    writtenBy: MetadataCenterWriter,
    reason?: string
  ): void {
    if (value === undefined) {
      return;
    }
    const previous = this.state.requestTruth[key] as MetadataCenterSlot<MetadataCenterRequestTruth[K]> | undefined;
    if (previous) {
      throw new Error(`MetadataCenter request_truth.${String(key)} is write-once and already set`);
    }
    this.state.requestTruth[key] = buildSlot({
      value,
      family: 'request_truth',
      writtenBy,
      writePolicy: 'write_once',
      previous,
      reason
    });
  }

  writeContinuationContext<K extends keyof MetadataCenterContinuationContext>(
    key: K,
    value: MetadataCenterContinuationContext[K],
    writtenBy: MetadataCenterWriter,
    reason?: string
  ): void {
    if (value === undefined) {
      return;
    }
    const previous = this.state.continuationContext[key] as MetadataCenterSlot<MetadataCenterContinuationContext[K]> | undefined;
    this.state.continuationContext[key] = buildSlot({
      value,
      family: 'continuation_context',
      writtenBy,
      writePolicy: 'replaceable_by_owner_only',
      previous,
      reason
    });
  }

  readRequestTruth(): MetadataCenterRequestTruth {
    return {
      requestId: this.state.requestTruth.requestId?.value as string | undefined,
      pipelineId: this.state.requestTruth.pipelineId?.value as string | undefined,
      entryEndpoint: this.state.requestTruth.entryEndpoint?.value as string | undefined,
      sessionId: this.state.requestTruth.sessionId?.value as string | undefined,
      conversationId: this.state.requestTruth.conversationId?.value as string | undefined,
      clientRequestId: this.state.requestTruth.clientRequestId?.value as string | undefined,
      portScope: this.state.requestTruth.portScope?.value as string | undefined
    };
  }

  readContinuationContext(): MetadataCenterContinuationContext {
    return {
      responsesResume: this.state.continuationContext.responsesResume?.value as Record<string, unknown> | undefined,
      previousResponseId: this.state.continuationContext.previousResponseId?.value as string | undefined,
      responseId: this.state.continuationContext.responseId?.value as string | undefined,
      toolOutputs: this.state.continuationContext.toolOutputs?.value as unknown[] | undefined,
      continuationOwner: this.state.continuationContext.continuationOwner?.value as string | undefined,
      resumeFrom: this.state.continuationContext.resumeFrom?.value as Record<string, unknown> | undefined,
      chainId: this.state.continuationContext.chainId?.value as string | undefined,
      stickyScope: this.state.continuationContext.stickyScope?.value as string | undefined
    };
  }

  writeRuntimeControl<K extends keyof MetadataCenterRuntimeControl>(
    key: K,
    value: MetadataCenterRuntimeControl[K],
    writtenBy: MetadataCenterWriter,
    reason?: string
  ): void {
    if (value === undefined) {
      return;
    }
    const previous = this.state.runtimeControl[key] as MetadataCenterSlot<MetadataCenterRuntimeControl[K]> | undefined;
    this.state.runtimeControl[key] = buildSlot({
      value,
      family: 'runtime_control',
      writtenBy,
      writePolicy: 'replaceable_by_owner_only',
      previous,
      reason
    });
  }

  releaseRuntimeControl<K extends keyof MetadataCenterRuntimeControl>(
    key: K,
    changedBy: MetadataCenterWriter,
    reason?: string
  ): void {
    void changedBy;
    void reason;
    if (!this.state.runtimeControl[key]) {
      return;
    }
    delete this.state.runtimeControl[key];
  }

  readRuntimeControl(): MetadataCenterRuntimeControl {
    return {
      routeHint: this.state.runtimeControl.routeHint?.value as string | undefined,
      routeName: this.state.runtimeControl.routeName?.value as string | undefined,
      routeId: this.state.runtimeControl.routeId?.value as string | undefined,
      providerProtocol: this.state.runtimeControl.providerProtocol?.value as string | undefined,
      retryProviderKey: this.state.runtimeControl.retryProviderKey?.value as string | undefined,
      preselectedRoute: this.state.runtimeControl.preselectedRoute?.value as Record<string, unknown> | undefined,
      responsesContinuationSavedAtChatProcessExit:
        this.state.runtimeControl.responsesContinuationSavedAtChatProcessExit?.value as boolean | undefined,
      stopless: this.state.runtimeControl.stopless?.value as MetadataCenterRuntimeControl['stopless'] | undefined,
      stopMessageCompareContext: this.state.runtimeControl.stopMessageCompareContext?.value as MetadataCenterRuntimeControl['stopMessageCompareContext'] | undefined,
      stopMessageEnabled: this.state.runtimeControl.stopMessageEnabled?.value as boolean | undefined,
      stopMessageExcludeDirect: this.state.runtimeControl.stopMessageExcludeDirect?.value as boolean | undefined,
      streamIntent: this.state.runtimeControl.streamIntent?.value as string | undefined,
      clientAbort: this.state.runtimeControl.clientAbort?.value as boolean | undefined
    };
  }

  writeProviderObservation<K extends keyof MetadataCenterProviderObservation>(
    key: K,
    value: MetadataCenterProviderObservation[K],
    writtenBy: MetadataCenterWriter,
    reason?: string
  ): void {
    if (value === undefined) {
      return;
    }
    const previous = this.state.providerObservation[key] as MetadataCenterSlot<MetadataCenterProviderObservation[K]> | undefined;
    this.state.providerObservation[key] = buildSlot({
      value,
      family: 'provider_observation',
      writtenBy,
      writePolicy: 'append_only',
      previous,
      reason
    });
  }

  readProviderObservation(): MetadataCenterProviderObservation {
    return {
      target: this.state.providerObservation.target?.value as Record<string, unknown> | undefined,
      providerKey: this.state.providerObservation.providerKey?.value as string | undefined,
      assignedModelId: this.state.providerObservation.assignedModelId?.value as string | undefined,
      modelId: this.state.providerObservation.modelId?.value as string | undefined,
      clientModelId: this.state.providerObservation.clientModelId?.value as string | undefined,
      compatibilityProfile: this.state.providerObservation.compatibilityProfile?.value as string | undefined,
      responseSemantics: this.state.providerObservation.responseSemantics?.value as Record<string, unknown> | undefined,
      finishReason: this.state.providerObservation.finishReason?.value as string | undefined
    };
  }

  writeResponseObservation<K extends keyof MetadataCenterResponseObservation>(
    key: K,
    value: MetadataCenterResponseObservation[K],
    writtenBy: MetadataCenterWriter,
    reason?: string
  ): void {
    if (value === undefined) {
      return;
    }
    const previous = this.state.responseObservation[key] as MetadataCenterSlot<MetadataCenterResponseObservation[K]> | undefined;
    this.state.responseObservation[key] = buildSlot({
      value,
      family: 'response_observation',
      writtenBy,
      writePolicy: 'append_only',
      previous,
      reason
    });
  }

  readResponseObservation(): MetadataCenterResponseObservation {
    return {
      responseId: this.state.responseObservation.responseId?.value as string | undefined,
      status: this.state.responseObservation.status?.value as string | undefined,
      finishReason: this.state.responseObservation.finishReason?.value as string | undefined,
      protocolKind: this.state.responseObservation.protocolKind?.value as string | undefined
    };
  }

  writeCloseoutStatus<K extends keyof MetadataCenterCloseoutStatus>(
    key: K,
    value: MetadataCenterCloseoutStatus[K],
    writtenBy: MetadataCenterWriter,
    reason?: string
  ): void {
    if (value === undefined) {
      return;
    }
    const previous = this.state.closeoutStatus[key] as MetadataCenterSlot<MetadataCenterCloseoutStatus[K]> | undefined;
    this.state.closeoutStatus[key] = buildSlot({
      value,
      family: 'closeout_status',
      writtenBy,
      writePolicy: 'finalize_only',
      previous,
      reason
    });
  }

  readCloseoutStatus(): MetadataCenterCloseoutStatus {
    return {
      finalized: this.state.closeoutStatus.finalized?.value as boolean | undefined,
      released: this.state.closeoutStatus.released?.value as boolean | undefined,
      releasedAt: this.state.closeoutStatus.releasedAt?.value as number | undefined,
      releaseReason: this.state.closeoutStatus.releaseReason?.value as string | undefined,
      releasedByStage: this.state.closeoutStatus.releasedByStage?.value as string | undefined
    };
  }

  writeDebugSnapshot<K extends keyof MetadataCenterDebugSnapshot>(
    key: K,
    value: MetadataCenterDebugSnapshot[K],
    writtenBy: MetadataCenterWriter,
    reason?: string
  ): void {
    if (value === undefined) {
      return;
    }
    const previous = this.state.debugSnapshot[key] as MetadataCenterSlot<MetadataCenterDebugSnapshot[K]> | undefined;
    this.state.debugSnapshot[key] = buildSlot({
      value,
      family: 'debug_snapshot',
      writtenBy,
      writePolicy: 'append_only',
      previous,
      reason
    });
  }

  readDebugSnapshot(): MetadataCenterDebugSnapshot {
    return {
      snapshotId: this.state.debugSnapshot.snapshotId?.value as string | undefined,
      bridgeHistory: this.state.debugSnapshot.bridgeHistory?.value as unknown[] | undefined,
      traceMarkers: this.state.debugSnapshot.traceMarkers?.value as unknown[] | undefined,
      hubStageTop: this.state.debugSnapshot.hubStageTop?.value as MetadataCenterDebugSnapshot['hubStageTop'] | undefined
    };
  }

  markReleased(writtenBy: MetadataCenterWriter, reason?: string): void {
    for (const key of Object.keys(this.state.requestTruth) as Array<keyof MetadataCenterRequestTruth>) {
      const slot = this.state.requestTruth[key];
      if (!slot) {
        continue;
      }
      this.state.requestTruth[key] = transitionSlotStatus({
        previous: slot,
        status: 'released',
        changedBy: writtenBy,
        reason,
      });
    }
    for (const key of Object.keys(this.state.continuationContext) as Array<keyof MetadataCenterContinuationContext>) {
      const slot = this.state.continuationContext[key];
      if (!slot) {
        continue;
      }
      this.state.continuationContext[key] = transitionSlotStatus({
        previous: slot,
        status: 'released',
        changedBy: writtenBy,
        reason,
      });
    }
    for (const key of Object.keys(this.state.runtimeControl) as Array<keyof MetadataCenterRuntimeControl>) {
      const slot = this.state.runtimeControl[key];
      if (!slot) {
        continue;
      }
      this.state.runtimeControl[key] = transitionSlotStatus({
        previous: slot,
        status: 'released',
        changedBy: writtenBy,
        reason,
      });
    }
    for (const key of Object.keys(this.state.providerObservation) as Array<keyof MetadataCenterProviderObservation>) {
      const slot = this.state.providerObservation[key];
      if (!slot) {
        continue;
      }
      this.state.providerObservation[key] = transitionSlotStatus({
        previous: slot,
        status: 'released',
        changedBy: writtenBy,
        reason,
      });
    }
    for (const key of Object.keys(this.state.responseObservation) as Array<keyof MetadataCenterResponseObservation>) {
      const slot = this.state.responseObservation[key];
      if (!slot) {
        continue;
      }
      this.state.responseObservation[key] = transitionSlotStatus({
        previous: slot,
        status: 'released',
        changedBy: writtenBy,
        reason,
      });
    }
    for (const key of Object.keys(this.state.closeoutStatus) as Array<keyof MetadataCenterCloseoutStatus>) {
      const slot = this.state.closeoutStatus[key];
      if (!slot) {
        continue;
      }
      this.state.closeoutStatus[key] = transitionSlotStatus({
        previous: slot,
        status: 'released',
        changedBy: writtenBy,
        reason,
      });
    }
    for (const key of Object.keys(this.state.debugSnapshot) as Array<keyof MetadataCenterDebugSnapshot>) {
      const slot = this.state.debugSnapshot[key];
      if (!slot) {
        continue;
      }
      this.state.debugSnapshot[key] = transitionSlotStatus({
        previous: slot,
        status: 'released',
        changedBy: writtenBy,
        reason,
      });
    }
  }

  snapshot(): MetadataCenterState {
    return this.state;
  }
}

export const METADATA_CENTER_RUNTIME_SYMBOL = METADATA_CENTER_SYMBOL;

export type MetadataCenterReleasedSnapshot = {
  requestId?: string;
  sessionId?: string;
  releasedAt: number;
  reason?: string;
  state: MetadataCenterState;
};

type MetadataCenterSessionBuffer = Map<string, MetadataCenterReleasedSnapshot[]>;

function getSessionBuffer(): MetadataCenterSessionBuffer {
  const globalRecord = globalThis as Record<symbol, unknown>;
  const existing = globalRecord[METADATA_CENTER_SESSION_BUFFER_SYMBOL];
  if (existing instanceof Map) {
    return existing as MetadataCenterSessionBuffer;
  }
  const created: MetadataCenterSessionBuffer = new Map();
  globalRecord[METADATA_CENTER_SESSION_BUFFER_SYMBOL] = created;
  return created;
}

function cloneMetadataCenterState(state: MetadataCenterState): MetadataCenterState {
  return structuredClone(state) as MetadataCenterState;
}

function rememberReleasedMetadataCenter(center: MetadataCenter, reason?: string): void {
  const requestTruth = center.readRequestTruth();
  const sessionId = requestTruth.sessionId?.trim();
  if (!sessionId) {
    return;
  }
  const buffer = getSessionBuffer();
  const entries = buffer.get(sessionId) ?? [];
  entries.push({
    ...(requestTruth.requestId ? { requestId: requestTruth.requestId } : {}),
    sessionId,
    releasedAt: now(),
    ...(reason ? { reason } : {}),
    state: cloneMetadataCenterState(center.snapshot()),
  });
  if (entries.length > METADATA_CENTER_SESSION_BUFFER_LIMIT) {
    entries.splice(0, entries.length - METADATA_CENTER_SESSION_BUFFER_LIMIT);
  }
  buffer.set(sessionId, entries);
}

export function readReleasedMetadataCenterSessionBuffer(sessionId: string): MetadataCenterReleasedSnapshot[] {
  const trimmed = sessionId.trim();
  if (!trimmed) {
    return [];
  }
  return (getSessionBuffer().get(trimmed) ?? []).map((entry) => structuredClone(entry) as MetadataCenterReleasedSnapshot);
}

export function releaseMetadataCenterForHttpResponse(metadata: unknown, reason?: string): void {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return;
  }
  const center = MetadataCenter.read(metadata as Record<string, unknown>);
  if (!center) {
    return;
  }
  center.markReleased(HTTP_RESPONSE_METADATA_RELEASE_WRITER, reason);
  rememberReleasedMetadataCenter(center, reason);
}
