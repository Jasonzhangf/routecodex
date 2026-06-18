import type {
  MetadataCenterClientAttachmentScope,
  MetadataCenterContinuationContext,
  MetadataCenterDebugSnapshot,
  MetadataCenterFamily,
  MetadataCenterProviderObservation,
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

export class MetadataCenter {
  private readonly state: MetadataCenterState;

  constructor() {
    this.state = {
      requestTruth: {},
      continuationContext: {},
      runtimeControl: {},
      providerObservation: {},
      clientAttachmentScope: {},
      debugSnapshot: {}
    };
  }

  static attach(target: Record<string, unknown>): MetadataCenter {
    const existing = Reflect.get(target, METADATA_CENTER_SYMBOL) as MetadataCenter | undefined;
    if (existing instanceof MetadataCenter) {
      return existing;
    }
    const created = new MetadataCenter();
    Reflect.set(target, METADATA_CENTER_SYMBOL, created);
    return created;
  }

  static bind(target: Record<string, unknown>, center: MetadataCenter): void {
    Reflect.set(target, METADATA_CENTER_SYMBOL, center);
  }

  static read(target: Record<string, unknown> | undefined): MetadataCenter | undefined {
    if (!target) {
      return undefined;
    }
    const existing = Reflect.get(target, METADATA_CENTER_SYMBOL);
    return existing instanceof MetadataCenter ? existing : undefined;
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
      writePolicy: 'replaceable',
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
      responsesRequestContext: this.state.continuationContext.responsesRequestContext?.value as Record<string, unknown> | undefined,
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
      writePolicy: 'replaceable',
      previous,
      reason
    });
  }

  readRuntimeControl(): MetadataCenterRuntimeControl {
    return {
      routeHint: this.state.runtimeControl.routeHint?.value as string | undefined,
      routeName: this.state.runtimeControl.routeName?.value as string | undefined,
      routeId: this.state.runtimeControl.routeId?.value as string | undefined,
      providerProtocol: this.state.runtimeControl.providerProtocol?.value as string | undefined,
      providerFamily: this.state.runtimeControl.providerFamily?.value as string | undefined,
      retryProviderKey: this.state.runtimeControl.retryProviderKey?.value as string | undefined,
      preselectedRoute: this.state.runtimeControl.preselectedRoute?.value as Record<string, unknown> | undefined,
      serverToolFollowup: this.state.runtimeControl.serverToolFollowup?.value as boolean | undefined,
      serverToolFollowupSource: this.state.runtimeControl.serverToolFollowupSource?.value as string | undefined,
      stoplessGoalStatus: this.state.runtimeControl.stoplessGoalStatus?.value as string | undefined,
      stopless: this.state.runtimeControl.stopless?.value as MetadataCenterRuntimeControl['stopless'] | undefined,
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
      writePolicy: 'replaceable',
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

  writeClientAttachmentScope<K extends keyof MetadataCenterClientAttachmentScope>(
    key: K,
    value: MetadataCenterClientAttachmentScope[K],
    writtenBy: MetadataCenterWriter,
    reason?: string
  ): void {
    if (value === undefined) {
      return;
    }
    const previous = this.state.clientAttachmentScope[key] as MetadataCenterSlot<MetadataCenterClientAttachmentScope[K]> | undefined;
    this.state.clientAttachmentScope[key] = buildSlot({
      value,
      family: 'client_attachment_scope',
      writtenBy,
      writePolicy: 'replaceable',
      previous,
      reason
    });
  }

  readClientAttachmentScope(): MetadataCenterClientAttachmentScope {
    return {
      daemonId: this.state.clientAttachmentScope.daemonId?.value as string | undefined,
      tmuxSessionId: this.state.clientAttachmentScope.tmuxSessionId?.value as string | undefined,
      tmuxTarget: this.state.clientAttachmentScope.tmuxTarget?.value as string | undefined,
      workdir: this.state.clientAttachmentScope.workdir?.value as string | undefined
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
      traceMarkers: this.state.debugSnapshot.traceMarkers?.value as unknown[] | undefined
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
    for (const key of Object.keys(this.state.clientAttachmentScope) as Array<keyof MetadataCenterClientAttachmentScope>) {
      const slot = this.state.clientAttachmentScope[key];
      if (!slot) {
        continue;
      }
      this.state.clientAttachmentScope[key] = transitionSlotStatus({
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

export function releaseMetadataCenterForHttpResponse(metadata: unknown, reason?: string): void {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return;
  }
  MetadataCenter.read(metadata as Record<string, unknown>)
    ?.markReleased(HTTP_RESPONSE_METADATA_RELEASE_WRITER, reason);
}
