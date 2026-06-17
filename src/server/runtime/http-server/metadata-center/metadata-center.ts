import type {
  MetadataCenterContinuationContext,
  MetadataCenterFamily,
  MetadataCenterRequestTruth,
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

export class MetadataCenter {
  private readonly state: MetadataCenterState;

  constructor() {
    this.state = {
      requestTruth: {},
      continuationContext: {}
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

  snapshot(): MetadataCenterState {
    return this.state;
  }
}

export const METADATA_CENTER_RUNTIME_SYMBOL = METADATA_CENTER_SYMBOL;
