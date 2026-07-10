import { PassThrough, type Readable } from 'node:stream';
import { getRouterHotpathJsonBindingSync } from './native-exports.js';
import {
  recordResponsesResponse,
  finalizeResponsesConversationRequestRetention,
} from './responses-conversation-store-host.js';

type AdapterContext = Record<string, unknown>;
type JsonObject = Record<string, unknown>;
type StageRecorder = { record(stage: string, payload: object): void };
type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat';
type NativeSseRuntimeProtocol = string;
type NativeSseFramesOutput = {
  frames: string[];
  stats?: Record<string, unknown>;
};

type ProviderResponseRuntimeEffectPlan = {
  servertoolRuntimeActions?: unknown[];
  stoplessMetadataCenterWrite?: unknown;
  runtimeStateWrite?: unknown;
  streamPipe?: unknown;
  [key: string]: unknown;
};

type PublishResponsesRecordPlan = {
  recordArgs: {
    requestId: string;
    response: Record<string, unknown>;
    sessionId?: string;
    conversationId?: string;
    providerKey?: string;
    matchedPort?: number;
    routingPolicyGroup?: string;
    routeHint?: string;
  } | null;
  finalizeArgs: {
    requestId: string;
    keepForSubmitToolOutputs: boolean;
  } | null;
  usageArgs: {
    usage?: unknown;
  } | null;
};

type NativeHubPipelineProtocolModule = {
  executeHubPipelineWithNative?: (input: {
    config: Record<string, unknown>;
    request: Record<string, unknown>;
  }) => {
    success: boolean;
    requestId: string;
    payload?: unknown;
    error?: { code?: string; message?: string };
    effectPlan: { effects: unknown[] };
    diagnostics: Array<Record<string, unknown>>;
  };
  buildProviderResponseMetadataSnapshotWithNative?: (input: unknown) => {
    metadataCenterSnapshot?: Record<string, unknown> | null;
  };
  normalizeProviderResponseEffectPlanWithNative?: (input: { effects: unknown[] }) => ProviderResponseRuntimeEffectPlan;
  resolveProviderProtocolWithNative?: (input: unknown) => { providerProtocol: string };
};

type NativeSharedSemanticsModule = {
  publishResponsesRecordPlanWithNative?: (args: {
    requestId: string;
    response: unknown;
    context: unknown;
    runtimeStateWrite: unknown;
    entryEndpoint: string;
  }) => PublishResponsesRecordPlan;
};

type RuntimeMetadataModule = {
  ensureRuntimeMetadata?: (carrier: Record<string, unknown>) => JsonObject;
};

type NativeRespSemanticsModule = {
  resolveProviderResponseContextHelpersWithNative?: (input: {
    context: AdapterContext;
    legacyFollowupMarkerRaw?: unknown;
    entryEndpoint?: string;
    toolSurfaceModeRaw?: string;
  }) => {
    isServerToolFollowup?: boolean;
    toolSurfaceShadowEnabled?: boolean;
    clientProtocol: 'openai-chat' | 'openai-responses' | 'anthropic-messages';
    displayModel?: string;
    clientFacingRequestId: string;
  };
  buildProviderSseStreamReadErrorDescriptorWithNative?: (input: {
    message: string;
    code?: string;
    upstreamCode?: string;
  }) => {
    message: string;
    code?: string;
    upstreamCode?: string;
    statusCode?: number;
    retryable?: boolean;
    requestExecutorProviderErrorStage?: string;
  };
  materializeProviderResponseSsePayloadWithNative?: (input: {
    payload: unknown;
    streamBodyText?: string;
  }) => Record<string, unknown>;
};

type RuntimeControlWriter = { module: string; symbol: string; stage: string };
type MetadataCenterLike = {
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

const METADATA_CENTER_SYMBOL = Symbol.for('routecodex.metadataCenter');
const RUST_SNAPSHOT_SYMBOL = Symbol.for('routecodex.metadataCenter.rustSnapshot');

function requireNativeBindingFunction(capability: string): (...args: string[]) => unknown {
  const binding = getRouterHotpathJsonBindingSync() as unknown as Record<string, unknown>;
  const fn = binding[capability];
  if (typeof fn !== 'function') {
    throw new Error(`[provider-response-converter-host] ${capability} not available`);
  }
  return fn as (...args: string[]) => unknown;
}

function callNativeJsonObject<T>(capability: string, input: unknown): T {
  const fn = requireNativeBindingFunction(capability);
  const raw = fn(JSON.stringify(input ?? null));
  if (typeof raw !== 'string' || !raw) {
    throw new Error(`[provider-response-converter-host] ${capability} returned empty result`);
  }
  return JSON.parse(raw) as T;
}

function executeHubPipelineWithNative(
  input: Parameters<NonNullable<NativeHubPipelineProtocolModule['executeHubPipelineWithNative']>>[0]
): ReturnType<NonNullable<NativeHubPipelineProtocolModule['executeHubPipelineWithNative']>> {
  return callNativeJsonObject('executeHubPipelineJson', input);
}

function buildProviderResponseMetadataSnapshotWithNative(
  input: Parameters<NonNullable<NativeHubPipelineProtocolModule['buildProviderResponseMetadataSnapshotWithNative']>>[0]
): ReturnType<NonNullable<NativeHubPipelineProtocolModule['buildProviderResponseMetadataSnapshotWithNative']>> {
  return callNativeJsonObject('buildProviderResponseMetadataSnapshotJson', input);
}

function normalizeProviderResponseEffectPlanWithNative(
  input: Parameters<NonNullable<NativeHubPipelineProtocolModule['normalizeProviderResponseEffectPlanWithNative']>>[0]
): ReturnType<NonNullable<NativeHubPipelineProtocolModule['normalizeProviderResponseEffectPlanWithNative']>> {
  return callNativeJsonObject('normalizeProviderResponseEffectPlanJson', input);
}

function resolveProviderProtocolWithNative(
  input: Parameters<NonNullable<NativeHubPipelineProtocolModule['resolveProviderProtocolWithNative']>>[0]
): ReturnType<NonNullable<NativeHubPipelineProtocolModule['resolveProviderProtocolWithNative']>> {
  return callNativeJsonObject('resolveProviderProtocolJson', input);
}

function publishResponsesRecordPlanWithNative(
  args: Parameters<NonNullable<NativeSharedSemanticsModule['publishResponsesRecordPlanWithNative']>>[0]
): ReturnType<NonNullable<NativeSharedSemanticsModule['publishResponsesRecordPlanWithNative']>> {
  const fn = requireNativeBindingFunction('publishResponsesRecordPlanJson');
  const raw = fn(
    String(args.requestId ?? ''),
    JSON.stringify(args.response ?? null),
    JSON.stringify(args.context ?? null),
    JSON.stringify(args.runtimeStateWrite ?? null),
    String(args.entryEndpoint ?? '')
  );
  if (typeof raw !== 'string' || !raw) {
    throw new Error('[provider-response-converter-host] publishResponsesRecordPlanJson returned empty result');
  }
  return JSON.parse(raw) as ReturnType<NonNullable<NativeSharedSemanticsModule['publishResponsesRecordPlanWithNative']>>;
}

function ensureRuntimeMetadata(carrier: Record<string, unknown>): JsonObject {
  const nextCarrier = callNativeJsonObject<Record<string, unknown>>('ensureRuntimeMetadataJson', carrier);
  const directCenter = Reflect.get(carrier, METADATA_CENTER_SYMBOL);
  const rustSnapshot = Reflect.get(carrier, RUST_SNAPSHOT_SYMBOL);
  Object.assign(carrier, nextCarrier);
  if (directCenter !== undefined) {
    Reflect.set(carrier, METADATA_CENTER_SYMBOL, directCenter);
  }
  if (rustSnapshot !== undefined) {
    Reflect.set(carrier, RUST_SNAPSHOT_SYMBOL, rustSnapshot);
  }
  const existing = carrier.__rt;
  if (isRecord(existing)) {
    return existing as JsonObject;
  }
  carrier.__rt = {};
  return carrier.__rt as JsonObject;
}

function buildProviderSseStreamReadErrorDescriptorWithNative(
  input: Parameters<NonNullable<NativeRespSemanticsModule['buildProviderSseStreamReadErrorDescriptorWithNative']>>[0]
): ReturnType<NonNullable<NativeRespSemanticsModule['buildProviderSseStreamReadErrorDescriptorWithNative']>> {
  // feature_id: hub.response_provider_sse_materialization
  // canonical_builder: build_provider_sse_stream_read_error_descriptor
  return callNativeJsonObject('buildProviderSseStreamReadErrorDescriptorJson', input);
}

function materializeProviderResponseSsePayloadWithNative(
  input: Parameters<NonNullable<NativeRespSemanticsModule['materializeProviderResponseSsePayloadWithNative']>>[0]
): ReturnType<NonNullable<NativeRespSemanticsModule['materializeProviderResponseSsePayloadWithNative']>> {
  // feature_id: sse.responses_decode_projection
  // canonical_builder: build_responses_json_from_sse_json
  // canonical_builder: materialize_provider_response_sse_payload
  return callNativeJsonObject('materializeProviderResponseSsePayloadJson', input);
}

function resolveProviderResponseContextHelpersWithNative(
  input: Parameters<NonNullable<NativeRespSemanticsModule['resolveProviderResponseContextHelpersWithNative']>>[0]
): ReturnType<NonNullable<NativeRespSemanticsModule['resolveProviderResponseContextHelpersWithNative']>> {
  const fn = requireNativeBindingFunction('resolveProviderResponseContextHelpersJson');
  const raw = fn(
    JSON.stringify(input.context ?? {}),
    JSON.stringify(input.legacyFollowupMarkerRaw ?? null),
    JSON.stringify(typeof input.entryEndpoint === 'string' ? input.entryEndpoint : null),
    JSON.stringify(input.toolSurfaceModeRaw ?? null)
  );
  if (typeof raw !== 'string' || !raw) {
    throw new Error('[provider-response-converter-host] resolveProviderResponseContextHelpersJson returned empty result');
  }
  return JSON.parse(raw) as ReturnType<NonNullable<NativeRespSemanticsModule['resolveProviderResponseContextHelpersWithNative']>>;
}

function planChatProcessSessionUsageWithNative(input: {
  context: Record<string, unknown>;
  usage?: Record<string, unknown>;
}): unknown {
  const binding = getRouterHotpathJsonBindingSync() as unknown as Record<string, unknown>;
  const fn = binding.planChatProcessSessionUsageJson as undefined | ((inputJson: string) => string);
  if (typeof fn !== 'function') {
    throw new Error('[provider-response-converter-host] native routing state.planChatProcessSessionUsageJson not available');
  }
  return JSON.parse(fn(JSON.stringify(input ?? {}))) as unknown;
}

function buildSseFramesFromJsonWithNative(input: {
  protocol: string;
  response: unknown;
  requestId: string;
  model: string;
}): NativeSseFramesOutput {
  const binding = getRouterHotpathJsonBindingSync() as unknown as Record<string, unknown>;
  const fn = binding.buildSseFramesFromJsonJson as undefined | ((inputJson: string) => string);
  if (typeof fn !== 'function') {
    throw new Error('[provider-response-converter-host] native sse runtime.buildSseFramesFromJsonJson not available');
  }
  const parsed = JSON.parse(fn(JSON.stringify({
    protocol: input.protocol,
    response: input.response,
    request_id: input.requestId,
    model: input.model,
    config: {},
  }))) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[provider-response-converter-host] native sse runtime.buildSseFramesFromJsonJson returned invalid result');
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.frames) || record.frames.some((frame) => typeof frame !== 'string')) {
    throw new Error('[provider-response-converter-host] native sse runtime.buildSseFramesFromJsonJson returned invalid frames');
  }
  return {
    frames: record.frames as string[],
    ...(isRecord(record.stats) ? { stats: record.stats } : {}),
  };
}

function buildReadableFromSseFrames(frames: string[]): Readable {
  const stream = new PassThrough({ objectMode: false });
  queueMicrotask(() => {
    try {
      for (const frame of frames) {
        if (!stream.writable) {
          break;
        }
        stream.write(frame);
      }
      if (stream.writable) {
        stream.end();
      }
    } catch (error) {
      stream.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
  return stream;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? (value as Record<string, unknown>) : undefined;
}

function readBoundMetadataCenter(target: Record<string, unknown>): MetadataCenterLike | undefined {
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

function readRuntimeControlFromBoundMetadataCenter(target: Record<string, unknown>): Record<string, unknown> {
  const runtimeControl = readBoundMetadataCenter(target)?.readRuntimeControl?.();
  return isRecord(runtimeControl) ? { ...runtimeControl } : {};
}

function readRequestTruthFromBoundMetadataCenter(target: Record<string, unknown>): Record<string, unknown> {
  const requestTruth = readBoundMetadataCenter(target)?.readRequestTruth?.();
  return isRecord(requestTruth) ? { ...requestTruth } : {};
}

function readContinuationContextFromBoundMetadataCenter(target: Record<string, unknown>): Record<string, unknown> {
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

function applyNativeRuntimeControlWritePlan(args: {
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

function projectNativeMetadataWritePlanToRuntimeControlWritePlan(plan: unknown): {
  runtimeControl?: Record<string, unknown>;
} {
  const binding = getRouterHotpathJsonBindingSync() as unknown as Record<string, unknown>;
  const fn = binding.projectMetadataWritePlanToRuntimeControlWritePlanJson as undefined | ((inputJson: string) => string);
  if (typeof fn !== 'function') {
    throw new Error('[provider-response-converter-host] native metadata writer.projectMetadataWritePlanToRuntimeControlWritePlanJson not available');
  }
  const parsed = JSON.parse(fn(JSON.stringify({ plan }))) as unknown;
  return isRecord(parsed) ? parsed as { runtimeControl?: Record<string, unknown> } : {};
}

function normalizeRecordPayload(payload: unknown): object {
  if (isRecord(payload)) {
    return payload;
  }
  if (typeof payload === 'string' && payload.trim()) {
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function recordStage(recorder: StageRecorder | undefined, stageId: string, payload: unknown): void {
  if (!recorder) {
    return;
  }
  try {
    recorder.record(stageId, normalizeRecordPayload(payload));
  } catch (error) {
    console.warn('[hub-pipeline] recordStage failed:', error instanceof Error ? error.message : String(error));
  }
}

function resolveProviderResponseContextSignals(
  context: AdapterContext,
  entryEndpoint?: string
): { clientProtocol: 'openai-chat' | 'openai-responses' | 'anthropic-messages' } {
  const resolved = resolveProviderResponseContextHelpersWithNative({
    context,
    legacyFollowupMarkerRaw: null,
    entryEndpoint,
    toolSurfaceModeRaw: String(process.env.ROUTECODEX_HUB_TOOL_SURFACE_MODE || '')
  });
  if (!readString(resolved.clientFacingRequestId)) {
    throw new Error('Rust provider response context helper returned no client-facing request id');
  }
  return { clientProtocol: resolved.clientProtocol };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readProviderResponseRequestId(context: AdapterContext): string {
  const requestId = readString((context as Record<string, unknown>).requestId);
  if (!requestId) {
    throw new Error('Provider response conversion requires context.requestId');
  }
  return requestId;
}

function readMetadataCenterSnapshotForRust(context: AdapterContext): Record<string, unknown> | null {
  const contextRecord = context as unknown as Record<string, unknown>;
  const direct = asRecord(contextRecord.metadataCenterSnapshot);
  const nestedMetadata = asRecord(contextRecord.metadata);
  const snapshotPlan = buildProviderResponseMetadataSnapshotWithNative({
    hasBoundMetadataCenter: Boolean(readBoundMetadataCenter(contextRecord)),
    requestTruth: readRequestTruthFromBoundMetadataCenter(contextRecord),
    continuationContext: readContinuationContextFromBoundMetadataCenter(contextRecord),
    runtimeControl: readRuntimeControlFromBoundMetadataCenter(contextRecord),
    directMetadataCenterSnapshot: direct ?? null,
    nestedMetadataCenterSnapshot: nestedMetadata ? asRecord(nestedMetadata.metadataCenterSnapshot) ?? null : null,
  });
  return snapshotPlan.metadataCenterSnapshot ?? null;
}



function writeRustStopGatewayContextToMetadataCenter(args: {
  metadata: Record<string, unknown>;
  stopGatewayContext: Record<string, unknown>;
  writer: { module: string; symbol: string; stage: string };
  reason: string;
}): void {
  applyNativeRuntimeControlWritePlan({
    metadata: args.metadata,
    runtimeControl: { stopGatewayContext: args.stopGatewayContext },
    writer: args.writer,
    reason: args.reason
  });
  ensureRuntimeMetadata(args.metadata).stopGatewayContext = args.stopGatewayContext as JsonObject;
}

function runProviderResponseRustHubPipeline(nativeOptions: Parameters<typeof executeHubPipelineWithNative>[0]) {
  const nativeResponsePlan = executeHubPipelineWithNative(nativeOptions);
  if (!nativeResponsePlan.success) {
    const code = nativeResponsePlan.error?.code ?? 'hub_pipeline_response_native_failed';
    const message = nativeResponsePlan.error?.message ?? 'Rust HubPipeline response path failed';
    throw new Error(`Rust HubPipeline response path failed: ${code}: ${message}`);
  }
  if (!nativeResponsePlan.payload || typeof nativeResponsePlan.payload !== 'object') {
    throw new Error('Rust HubPipeline response path returned no payload');
  }
  return nativeResponsePlan;
}

function emitNativeHubPipelineDiagnosticAlarms(args: {
  requestId: string;
  diagnostics: Array<Record<string, unknown>>;
}): void {
  for (const diagnostic of args.diagnostics) {
    const details = isRecord(diagnostic.details) ? diagnostic.details : null;
    const alarm = readString(details?.alarm);
    if (!alarm) {
      continue;
    }
    try {
      console.warn(
        `[hub-pipeline][alarm] ${alarm} requestId=${args.requestId} details=${JSON.stringify(details)}`
      );
    } catch {
      console.warn(`[hub-pipeline][alarm] ${alarm} requestId=${args.requestId}`);
    }
  }
}

function executeProviderResponseNativeOutboundEffects(args: {
  context: AdapterContext;
  nativeResponsePlan: ReturnType<typeof executeHubPipelineWithNative>;
}): {
  rawPayload: JsonObject;
  runtimeEffects: ProviderResponseRuntimeEffectPlan;
} {
  const rawPayload = args.nativeResponsePlan.payload as JsonObject;
  const effects = args.nativeResponsePlan.effectPlan.effects;
  if (!Array.isArray(effects)) {
    throw new Error('Rust HubPipeline response path returned malformed effect plan');
  }
  emitNativeHubPipelineDiagnosticAlarms({
    requestId: args.nativeResponsePlan.requestId,
    diagnostics: args.nativeResponsePlan.diagnostics
  });
  const normalizedEffects = normalizeProviderResponseEffectPlanWithNative({ effects });
  const runtimeEffects = normalizedEffects as ProviderResponseRuntimeEffectPlan;
  (args.context as Record<string, unknown>).__nativeResponsePlan = {
    payload: rawPayload,
    effectPlan: { effects },
    runtimeEffects,
    diagnostics: args.nativeResponsePlan.diagnostics
  };
  return { rawPayload, runtimeEffects };
}

async function executeProviderResponseNativeServertoolEffects(args: {
  payload: JsonObject;
  runtimeEffects: ProviderResponseRuntimeEffectPlan;
  context: AdapterContext;
  requestId: string;
  entryEndpoint: string;
  providerProtocol: ProviderProtocol;
  stageRecorder?: StageRecorder;
}): Promise<{ payload: JsonObject; stage: 'HubRespChatProcess03Governed' | 'unchanged' }> {
  if (!Array.isArray(args.runtimeEffects.servertoolRuntimeActions)) {
    throw new Error('Rust HubPipeline response path returned malformed servertool runtime actions');
  }
  const servertoolRuntimeActions = args.runtimeEffects.servertoolRuntimeActions;
  if (servertoolRuntimeActions.length > 0) {
    const firstAction = servertoolRuntimeActions.find(isRecord);
    const stopGateway = isRecord(firstAction?.stopGateway) ? firstAction.stopGateway : undefined;
    if (stopGateway) {
      writeRustStopGatewayContextToMetadataCenter({
        metadata: args.context as unknown as Record<string, unknown>,
        stopGatewayContext: stopGateway,
        writer: { module: 'provider-response.ts', symbol: 'convertProviderResponse', stage: 'HubRespChatProcess03Governed' },
        reason: 'rust stop gateway control signal'
      });
    }
    throw new Error('Rust HubPipeline returned unsupported servertool runtime actions; server-side tool execution has been removed and CLI-owned tools must be projected by Rust');
  }

  return { payload: args.payload, stage: 'unchanged' };
}

function executeProviderResponseNativeRuntimeStateEffect(args: {
  context: AdapterContext;
  entryEndpoint: string;
  requestId: string;
  response: JsonObject;
  runtimeEffects: ProviderResponseRuntimeEffectPlan;
}): void {
  if (args.runtimeEffects.stoplessMetadataCenterWrite) {
    const writePlan = projectNativeMetadataWritePlanToRuntimeControlWritePlan(args.runtimeEffects.stoplessMetadataCenterWrite);
    if (writePlan.runtimeControl) {
      applyNativeRuntimeControlWritePlan({
        metadata: args.context as unknown as Record<string, unknown>,
        runtimeControl: writePlan.runtimeControl,
        writer: { module: 'provider-response.ts', symbol: 'convertProviderResponse', stage: 'HubRespChatProcess03Governed' },
        reason: 'rust response chatprocess runtime control'
      });
    }
  }

  const runtimeStateWrite = isRecord(args.runtimeEffects.runtimeStateWrite) ? args.runtimeEffects.runtimeStateWrite : null;
  const metadataCenterSnapshot = {
    requestTruth: readRequestTruthFromBoundMetadataCenter(args.context as unknown as Record<string, unknown>),
    runtimeControl: readRuntimeControlFromBoundMetadataCenter(args.context as unknown as Record<string, unknown>),
  };
  const plan: PublishResponsesRecordPlan = publishResponsesRecordPlanWithNative({
    requestId: args.requestId,
    response: args.response,
    context: metadataCenterSnapshot,
    runtimeStateWrite: runtimeStateWrite ?? null,
    entryEndpoint: args.entryEndpoint,
  });

  if (plan.recordArgs) {
    recordResponsesResponse({
      requestId: plan.recordArgs.requestId,
      response: plan.recordArgs.response as Parameters<typeof recordResponsesResponse>[0]['response'],
      ...(plan.recordArgs.sessionId ? { sessionId: plan.recordArgs.sessionId } : {}),
      ...(plan.recordArgs.conversationId ? { conversationId: plan.recordArgs.conversationId } : {}),
      ...(plan.recordArgs.providerKey ? { providerKey: plan.recordArgs.providerKey } : {}),
      entryKind: 'responses',
      continuationOwner: 'relay',
      matchedPort: plan.recordArgs.matchedPort,
      ...(plan.recordArgs.routingPolicyGroup ? { routingPolicyGroup: plan.recordArgs.routingPolicyGroup } : {}),
      allowScopeContinuation: true,
      ...(plan.recordArgs.routeHint ? { routeHint: plan.recordArgs.routeHint } : {}),
    });
  }
  if (plan.finalizeArgs) {
    finalizeResponsesConversationRequestRetention(
      plan.finalizeArgs.requestId,
      { keepForSubmitToolOutputs: plan.finalizeArgs.keepForSubmitToolOutputs }
    );
  }
  if (plan.usageArgs) {
    planChatProcessSessionUsageWithNative({
      context: args.context as unknown as Record<string, unknown>,
      usage: plan.usageArgs.usage as Record<string, unknown> | undefined
    });
  }
}

function readProviderResponseNativeStreamPipe(args: {
  runtimeEffects: ProviderResponseRuntimeEffectPlan;
}): { codec: NativeSseRuntimeProtocol | string; requestId: string; payload: JsonObject } | null {
  const streamPipe = isRecord(args.runtimeEffects.streamPipe)
    ? args.runtimeEffects.streamPipe
    : null;
  if (!streamPipe) {
    return null;
  }
  const codec = readString(streamPipe.codec);
  const requestId = readString(streamPipe.requestId);
  const payload = isRecord(streamPipe.payload) ? streamPipe.payload as JsonObject : null;
  if (!codec || !requestId || !payload) {
    throw new Error('Rust HubPipeline response path returned malformed stream pipe effect');
  }
  return { codec: codec as NativeSseRuntimeProtocol | string, requestId, payload };
}

async function materializeProviderResponseSsePayload(
  payload: unknown
): Promise<Record<string, unknown>> {
  const stream = extractProviderResponseSseStream(payload);
  let streamBodyText: string | undefined;
  if (stream) {
    try {
      streamBodyText = await readProviderResponseSseStreamText(stream);
    } catch (error) {
      const source = error as Record<string, unknown> | undefined;
      const descriptor = buildProviderSseStreamReadErrorDescriptorWithNative({
        message: error instanceof Error ? error.message : String(error ?? 'unknown'),
        ...(typeof source?.code === 'string' ? { code: source.code } : {}),
        ...(typeof source?.upstreamCode === 'string' ? { upstreamCode: source.upstreamCode } : {})
      });
      const wrapped = new Error(descriptor.message) as Error & {
        code?: string;
        upstreamCode?: string;
        statusCode?: number;
        retryable?: boolean;
        requestExecutorProviderErrorStage?: string;
      };
      wrapped.code = descriptor.code;
      wrapped.upstreamCode = descriptor.upstreamCode;
      wrapped.statusCode = descriptor.statusCode;
      wrapped.retryable = descriptor.retryable;
      wrapped.requestExecutorProviderErrorStage = descriptor.requestExecutorProviderErrorStage;
      throw wrapped;
    }
  }
  return materializeProviderResponseSsePayloadWithNative({
    payload,
    ...(streamBodyText !== undefined ? { streamBodyText } : {})
  });
}

function extractProviderResponseSseStream(payload: unknown): Readable | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const direct = record.sseStream;
  if (direct && typeof (direct as { pipe?: unknown }).pipe === 'function') {
    return direct as Readable;
  }
  const data = record.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const nested = data as Record<string, unknown>;
    const nestedStream = nested.sseStream;
    if (nestedStream && typeof (nestedStream as { pipe?: unknown }).pipe === 'function') {
      return nestedStream as Readable;
    }
  }
  return undefined;
}

async function readProviderResponseSseStreamText(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string | Uint8Array>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function convertProviderResponse(
  options: {
    providerProtocol: ProviderProtocol;
    providerResponse: JsonObject;
    context: AdapterContext;
    entryEndpoint: string;
    wantsStream: boolean;
    stageRecorder?: StageRecorder;
  }
): Promise<{
  body?: JsonObject;
  sseStream?: Readable;
  format?: string;
}> {
  const requestId = readProviderResponseRequestId(options.context);
  const metadataCenterSnapshot = readMetadataCenterSnapshotForRust(options.context);
  const providerProtocol = resolveProviderProtocolWithNative({
    metadataCenterSnapshot
  }).providerProtocol as ProviderProtocol;

  // Step 1: Materialize provider SSE payload via canonical Rust owner.
  const providerResponseMaterialized = await materializeProviderResponseSsePayload(options.providerResponse);

  // Step 2: Run Rust HubPipeline response path (normalize, govern, outbound)
  const nativeOptions: Parameters<typeof executeHubPipelineWithNative>[0] = {
    config: {},
    request: {
      requestId,
      endpoint: options.entryEndpoint,
      entryEndpoint: options.entryEndpoint,
      providerProtocol,
      payload: providerResponseMaterialized,
      metadata: {
        ...options.context,
        clientProtocol: resolveProviderResponseContextSignals(options.context, options.entryEndpoint).clientProtocol,
        entryEndpoint: options.entryEndpoint,
        stream: options.wantsStream
      },
      ...(metadataCenterSnapshot ? { metadataCenterSnapshot } : {}),
      stream: options.wantsStream,
      processMode: 'chat',
      direction: 'response',
      stage: 'outbound'
    }
  };
  const nativeResponsePlan = runProviderResponseRustHubPipeline(nativeOptions);

  // Step 3: Plan orchestration v2 — SSE materialize, usage, servertool plan, stream pipe, metadata write
  const outboundEffect = executeProviderResponseNativeOutboundEffects({
    context: options.context,
    nativeResponsePlan,
  });

  // Step 4: Reject retired server-side tool runtime actions.
  const respProcessEffect = await executeProviderResponseNativeServertoolEffects({
    payload: outboundEffect.rawPayload,
    runtimeEffects: outboundEffect.runtimeEffects,
    context: options.context,
    requestId,
    entryEndpoint: options.entryEndpoint,
    providerProtocol,
    stageRecorder: options.stageRecorder
  });
  let hubRespOutbound04ClientSemantic: JsonObject;
  hubRespOutbound04ClientSemantic = respProcessEffect.stage === 'HubRespChatProcess03Governed'
    ? respProcessEffect.payload
    : outboundEffect.rawPayload;

  // Step 5: Apply metadata write plan
  executeProviderResponseNativeRuntimeStateEffect({
    context: options.context,
    entryEndpoint: options.entryEndpoint,
    requestId,
    response: hubRespOutbound04ClientSemantic,
    runtimeEffects: outboundEffect.runtimeEffects,
  });

  // Step 7: Stream or body-only response
  const streamPipe = readProviderResponseNativeStreamPipe({
    runtimeEffects: outboundEffect.runtimeEffects
  });
  if (!streamPipe) {
    recordStage(options.stageRecorder, 'chat_process.resp.stage9.client_remap', hubRespOutbound04ClientSemantic);
    recordStage(options.stageRecorder, 'chat_process.resp.stage10.sse_stream', {
      passthrough: false,
      protocol: 'native-effect-plan',
      payload: hubRespOutbound04ClientSemantic
    });
    return { body: hubRespOutbound04ClientSemantic };
  }
  const streamClientSemantic =
    respProcessEffect.stage === 'HubRespChatProcess03Governed'
      ? hubRespOutbound04ClientSemantic
      : streamPipe.payload;
  hubRespOutbound04ClientSemantic = streamClientSemantic;
  const sseCodec = streamPipe.codec as NativeSseRuntimeProtocol | string;
  const frameResult = buildSseFramesFromJsonWithNative({
    protocol: sseCodec,
    response: hubRespOutbound04ClientSemantic,
    requestId,
    model: "",
  });
  const stream = buildReadableFromSseFrames(frameResult.frames);
  recordStage(options.stageRecorder, 'chat_process.resp.stage9.client_remap', hubRespOutbound04ClientSemantic);
  recordStage(options.stageRecorder, 'chat_process.resp.stage10.sse_stream', {
    passthrough: false,
    protocol: streamPipe.codec,
    payload: hubRespOutbound04ClientSemantic
  });
  return {
    sseStream: stream as Readable,
    body: hubRespOutbound04ClientSemantic,
    format: streamPipe.codec
  };
}
