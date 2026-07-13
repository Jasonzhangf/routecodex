import { PassThrough, type Readable } from 'node:stream';
import {
  buildProviderSseStreamReadErrorDescriptorWithNative,
  buildSseFramesFromJsonWithNative,
  executeHubPipelineWithNative,
  materializeProviderResponseSsePayloadWithNative,
  resolveProviderProtocolWithNative,
  resolveProviderResponseContextHelpersWithNative,
} from './provider-response-native-calls.js';
import {
  asRecord,
  isRecord,
  readMetadataCenterSnapshotForRust,
} from './provider-response-metadata-effects.js';
import {
  executeProviderResponseNativeOutboundEffects,
  executeProviderResponseNativeRuntimeStateEffect,
  executeProviderResponseNativeServertoolEffects,
  readProviderResponseNativeStreamPipe,
} from './provider-response-effects.js';

// feature_id: hub.response_post_servertool_client_projection
// Server-side tool execution has been removed; CLI-owned tools must be projected by Rust.
// Fail-fast enforcement is delegated to provider-response-effects.ts:
// executeProviderResponseNativeServertoolEffects -> writeRustStopGatewayContextToMetadataCenter
// -> applyNativeRuntimeControlWritePlan -> readBoundMetadataCenter.

export {
  detectRetryableEmptyAssistantResponseNative,
  hasRequestedToolsInSemanticsNative,
  isProviderNativeResumeContinuationNative,
  isRequiredToolCallTurnNative,
  isToolCallContinuationResponseNative,
  isToolResultFollowupTurnNative,
  resolveProviderResponseRequestSemanticsNative,
} from './provider-response-native-host.js';

export {
  asFlatRecord,
  buildChoicesArrayBridgeDebugDetailsWithNative,
  buildProviderResponseTimingBreakdownWithNative,
  containsBroadKillCommand,
  extractBridgeProviderResponsePayload,
  extractContentTextForStoplessScan,
  extractFirstBalancedJsonObject,
  extractLatestUserTextForStoplessScan,
  findNestedErrorMarker,
  findNestedRawString,
  hasInvalidShellWrapperShape,
  hasStoplessDirectiveInRequestPayload,
  isContextLengthExceededError,
  isGenericBridgeResponseContractError,
  isRetryableNetworkSseWrapperError,
  shouldAllowDirectResponsesPrebuiltSsePassthroughWithNative,
  tryParseJsonLikeString,
  validateCanonicalClientToolCall,
} from './provider-response-native-calls.js';

type AdapterContext = Record<string, unknown>;
type JsonObject = Record<string, unknown>;
type StageRecorder = { record(stage: string, payload: object): void };
type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat';

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

function runProviderResponseRustHubPipeline(nativeOptions: Parameters<typeof executeHubPipelineWithNative>[0]) {
  const nativeResponsePlan = executeHubPipelineWithNative(nativeOptions);
  if (!nativeResponsePlan.success) {
    const code = nativeResponsePlan.error?.code ?? 'hub_pipeline_response_native_failed';
    const message = nativeResponsePlan.error?.message ?? 'Rust HubPipeline response path failed';
    throw new Error(`Rust HubPipeline response path failed: ${code}: ${message}`);
  }
  return nativeResponsePlan;
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
  const sseCodec = streamPipe.codec;
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
