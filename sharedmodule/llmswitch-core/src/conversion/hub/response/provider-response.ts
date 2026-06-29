import type { Readable } from 'node:stream';
import { defaultSseCodecRegistry, type SseProtocol } from '../../../sse/index.js';
import type { AdapterContext } from '../types/chat-envelope.js';
import type { JsonObject } from '../types/json.js';
import type { StageRecorder } from '../format-adapters/index.js';
import { recordStage } from '../pipeline/stages/utils.js';
import {
  executeHubPipelineWithNative,
  normalizeProviderResponseEffectPlanWithNative,
  planProviderResponseServertoolRuntimeActionsWithNative,
  type ProviderResponseRuntimeEffectPlan,
} from '../../../native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.js';
import { logHubStageTiming } from '../pipeline/hub-stage-timing.js';
import {
  recordResponsesResponse,
  finalizeResponsesConversationRequestRetention,
} from '../../shared/responses-conversation-store.js';
import { saveChatProcessSessionActualUsage } from '../process/chat-process-session-usage.js';
import {
  resolveProviderResponseContextSignals,
  type ProviderProtocol
} from './provider-response-helpers.js';
import { runServertoolResponseStageOrchestrationShell } from '../../../servertool/response-stage-orchestration-shell.js';
import {
  buildProviderSseStreamReadErrorDescriptorWithNative,
  materializeProviderResponseSsePayloadWithNative,
  projectPostServertoolHubRespOutbound04ClientSemanticWithNative
} from '../../../native/router-hotpath/native-hub-pipeline-resp-semantics.js';
import {
  applyNativeRuntimeControlWritePlan,
  projectNativeMetadataWritePlanToRuntimeControl
} from '../metadata-center-runtime-control-writer.js';

const METADATA_CENTER_SYMBOL = Symbol.for('routecodex.metadataCenter');

type MetadataCenterLike = {
  readRequestTruth: () => Record<string, unknown> | undefined;
  readContinuationContext: () => Record<string, unknown> | undefined;
  readRuntimeControl: () => Record<string, unknown> | undefined;
  writeRuntimeControl?: (
    key: string,
    value: unknown,
    writtenBy: { module: string; symbol: string; stage: string },
    reason?: string
  ) => void;
};

function isMetadataCenterLike(value: unknown): value is MetadataCenterLike {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { readRequestTruth?: unknown }).readRequestTruth === 'function'
    && typeof (value as { readContinuationContext?: unknown }).readContinuationContext === 'function'
    && typeof (value as { readRuntimeControl?: unknown }).readRuntimeControl === 'function'
  );
}

function readBoundMetadataCenter(metadata?: Record<string, unknown>): MetadataCenterLike | undefined {
  if (!metadata) {
    return undefined;
  }
  const candidate = Reflect.get(metadata, METADATA_CENTER_SYMBOL);
  return isMetadataCenterLike(candidate) ? candidate : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readMetadataCenterSnapshotForRust(context: AdapterContext): Record<string, unknown> | null {
  const contextRecord = context as unknown as Record<string, unknown>;
  const boundCenter = readBoundMetadataCenter(contextRecord);
  if (boundCenter) {
    return {
      requestTruth: boundCenter.readRequestTruth() ?? {},
      continuationContext: boundCenter.readContinuationContext() ?? {},
      runtimeControl: boundCenter.readRuntimeControl() ?? {},
    };
  }
  const direct = asRecord(contextRecord.metadataCenterSnapshot);
  if (direct) {
    return direct;
  }
  const nestedMetadata = asRecord(contextRecord.metadata);
  return nestedMetadata ? asRecord(nestedMetadata.metadataCenterSnapshot) ?? null : null;
}

function readMetadataCenterRequestTruth(metadata?: Record<string, unknown>): Record<string, unknown> {
  return asRecord(readBoundMetadataCenter(metadata)?.readRequestTruth()) ?? {};
}

function readMetadataCenterRuntimeControl(metadata?: Record<string, unknown>): Record<string, unknown> {
  return asRecord(readBoundMetadataCenter(metadata)?.readRuntimeControl()) ?? {};
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
}

function readProviderProtocolWithinCore(args: {
  metadata?: Record<string, unknown>;
}): ProviderProtocol {
  const runtimeControl = readMetadataCenterRuntimeControl(args.metadata);
  const providerProtocol =
    typeof runtimeControl.providerProtocol === 'string' && runtimeControl.providerProtocol.trim()
      ? runtimeControl.providerProtocol.trim()
      : undefined;
  if (!providerProtocol) {
    throw new Error('Provider response conversion requires metadata center runtime_control.providerProtocol');
  }
  return providerProtocol as ProviderProtocol;
}

interface ProviderResponseConversionOptions {
  providerProtocol: ProviderProtocol;
  providerResponse: JsonObject;
  context: AdapterContext;
  entryEndpoint: string;
  wantsStream: boolean;
  stageRecorder?: StageRecorder;
}

interface ProviderResponseConversionResult {
  body?: JsonObject;
  sseStream?: Readable;
  format?: string;
}

async function materializeProviderResponseSsePayload(
  payload: unknown
): Promise<Record<string, unknown>> {
  const stream = extractProviderResponseSseStream(payload);
  const streamBodyText = stream ? await readProviderResponseSseStreamText(stream) : undefined;
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
  try {
    for await (const chunk of stream as AsyncIterable<Buffer | string | Uint8Array>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
    }
  } catch (error) {
    throw buildProviderSseStreamReadError(error);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function buildProviderSseStreamReadError(error: unknown): Error {
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
  return wrapped;
}

export async function convertProviderResponse(
  options: ProviderResponseConversionOptions
): Promise<ProviderResponseConversionResult> {
  const requestId = options.context.requestId || 'unknown';
  const providerProtocol = readProviderProtocolWithinCore({
    metadata: options.context as Record<string, unknown> | undefined
  });

  // Step 1: Materialize provider SSE payload via canonical Rust owner.
  const providerResponseMaterialized = await materializeProviderResponseSsePayload(options.providerResponse);

  // Step 2: Run Rust HubPipeline response path (normalize, govern, outbound)
  const metadataCenterSnapshot = readMetadataCenterSnapshotForRust(options.context);
  const nativeResponsePlan = executeHubPipelineWithNative({
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
  });
  if (!nativeResponsePlan.success) {
    const code = nativeResponsePlan.error?.code ?? 'hub_pipeline_response_native_failed';
    const message = nativeResponsePlan.error?.message ?? 'Rust HubPipeline response path failed';
    throw new Error(`Rust HubPipeline response path failed: ${code}: ${message}`);
  }
  if (!nativeResponsePlan.payload || typeof nativeResponsePlan.payload !== 'object') {
    throw new Error('Rust HubPipeline response path returned no payload');
  }

  // Step 3: Plan orchestration v2 — SSE materialize, usage, servertool plan, stream pipe, metadata write
  const rawPayload = nativeResponsePlan.payload as JsonObject;
  const effects = nativeResponsePlan.effectPlan.effects;
  const normalizedEffects = Array.isArray(effects)
    ? normalizeProviderResponseEffectPlanWithNative({ effects })
    : { servertoolRuntimeActions: [], streamPipe: null, runtimeStateWrite: null, stoplessMetadataCenterWrite: null };
  const runtimeEffects = normalizedEffects as ProviderResponseRuntimeEffectPlan;
  (options.context as Record<string, unknown>).__nativeResponsePlan = {
    payload: rawPayload,
    effectPlan: { effects: Array.isArray(effects) ? effects : [] },
    runtimeEffects,
    diagnostics: nativeResponsePlan.diagnostics
  };
  const servertoolRuntimeActions = Array.isArray(runtimeEffects.servertoolRuntimeActions)
    ? runtimeEffects.servertoolRuntimeActions
    : [];
  const runtimeControl = readMetadataCenterRuntimeControl(options.context as unknown as Record<string, unknown>);

  // Step 4: Apply servertool runtime actions via existing TS IO shell.
  let hubRespOutbound04ClientSemantic: JsonObject = rawPayload;
  const actionPlan = planProviderResponseServertoolRuntimeActionsWithNative({
    servertoolRuntimeActions
  });
  if (actionPlan.error) {
    throw new Error(actionPlan.error.message);
  }
  if (actionPlan.executionPlans.length > 0) {
    for (const executionPlan of actionPlan.executionPlans) {
      const stopGateway = isRecord(executionPlan.stopGateway) ? executionPlan.stopGateway : undefined;
      if (stopGateway) {
        writeRustStopGatewayContextToMetadataCenter({
          metadata: options.context as unknown as Record<string, unknown>,
          stopGatewayContext: stopGateway,
          writer: { module: 'provider-response.ts', symbol: 'convertProviderResponse', stage: 'HubRespChatProcess03Governed' },
          reason: 'rust stop gateway control signal'
        });
      }
      const allowFollowup = executionPlan.allowFollowup === true;
      const orchestration = await runServertoolResponseStageOrchestrationShell({
        payload: executionPlan.payload as JsonObject,
        adapterContext: options.context,
        requestId,
        entryEndpoint: options.entryEndpoint,
        providerProtocol,
        ...(allowFollowup ? { allowFollowup: true } : {}),
        stageRecorder: options.stageRecorder
      });
      if (orchestration.executed) {
        hubRespOutbound04ClientSemantic = orchestration.payload;
      }
    }
    // Re-project if servertool effects changed the payload
    if (actionPlan.executionPlans.some((plan) => plan.projectionStage === 'HubRespChatProcess03Governed')) {
      hubRespOutbound04ClientSemantic = projectPostServertoolHubRespOutbound04ClientSemanticWithNative({
        payload: hubRespOutbound04ClientSemantic,
        entryEndpoint: options.entryEndpoint,
        requestId,
        responseSemantics: options.context as unknown as Record<string, unknown>
      }) as JsonObject;
    }
  }

  // Step 5: Apply metadata write plan
  if (runtimeEffects.stoplessMetadataCenterWrite) {
    const runtimeControlProjected = projectNativeMetadataWritePlanToRuntimeControl(runtimeEffects.stoplessMetadataCenterWrite);
    if (Object.keys(runtimeControlProjected).length > 0) {
      applyNativeRuntimeControlWritePlan({
        metadata: options.context as unknown as Record<string, unknown>,
        runtimeControl: runtimeControlProjected,
        writer: { module: 'provider-response.ts', symbol: 'convertProviderResponse', stage: 'HubRespChatProcess03Govemed' },
        reason: 'rust response chatprocess runtime control'
      });
    }
  }

  // Step 6: Persist responses continuation lifecycle & session usage at chat-process exit
  const runtimeStateWrite = isRecord(runtimeEffects.runtimeStateWrite) ? runtimeEffects.runtimeStateWrite : null;
  const usage = isRecord(runtimeStateWrite?.usage) ? runtimeStateWrite.usage : null;
  if (options.entryEndpoint === '/v1/responses' || options.entryEndpoint === '/v1/responses.submit_tool_outputs') {
    const requestTruth = readMetadataCenterRequestTruth(options.context as unknown as Record<string, unknown>);
    const rc = readMetadataCenterRuntimeControl(options.context as unknown as Record<string, unknown>);
    const matchedPort = typeof requestTruth.matchedPort === 'number' && Number.isFinite(requestTruth.matchedPort) ? Math.floor(requestTruth.matchedPort) : undefined;
    const routingPolicyGroup = readString(requestTruth.routingPolicyGroup);
    recordResponsesResponse({
      requestId,
      response: hubRespOutbound04ClientSemantic,
      ...(readString(requestTruth.sessionId) ? { sessionId: readString(requestTruth.sessionId) } : {}),
      ...(readString(requestTruth.conversationId) ? { conversationId: readString(requestTruth.conversationId) } : {}),
      ...(usage && typeof usage.providerKey === 'string' ? { providerKey: usage.providerKey } : {}),
      entryKind: 'responses',
      continuationOwner: 'relay',
      ...(matchedPort !== undefined ? { matchedPort } : {}),
      ...(routingPolicyGroup ? { routingPolicyGroup } : {}),
      allowScopeContinuation: true,
      ...(typeof rc.routeHint === 'string' && rc.routeHint.trim() ? { routeHint: rc.routeHint.trim() } : {}),
    });
    finalizeResponsesConversationRequestRetention(
      requestId,
      { keepForSubmitToolOutputs: runtimeStateWrite?.keepForSubmitToolOutputs === true }
    );
  }
  // Persist session usage for tmux/session scope
  if (usage) {
    saveChatProcessSessionActualUsage({
      context: options.context,
      usage
    });
  }

  // Step 7: Stream or body-only response
  const streamPipe = isRecord(runtimeEffects.streamPipe)
    ? { codec: runtimeEffects.streamPipe.codec as SseProtocol, requestId: runtimeEffects.streamPipe.requestId as string }
    : null;
  if (!streamPipe) {
    recordStage(options.stageRecorder, 'chat_process.resp.stage9.client_remap', hubRespOutbound04ClientSemantic);
    recordStage(options.stageRecorder, 'chat_process.resp.stage10.sse_stream', {
      passthrough: false,
      protocol: 'native-effect-plan',
      payload: hubRespOutbound04ClientSemantic
    });
    return { body: hubRespOutbound04ClientSemantic };
  }
  const codec = defaultSseCodecRegistry.get(streamPipe.codec);
  logHubStageTiming(requestId, 'resp_outbound.stage2_codec_stream', 'start', { clientProtocol: streamPipe.codec });
  const stream = await codec.convertJsonToSse(hubRespOutbound04ClientSemantic, { requestId: streamPipe.requestId });
  logHubStageTiming(requestId, 'resp_outbound.stage2_codec_stream', 'completed', { clientProtocol: streamPipe.codec });
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
