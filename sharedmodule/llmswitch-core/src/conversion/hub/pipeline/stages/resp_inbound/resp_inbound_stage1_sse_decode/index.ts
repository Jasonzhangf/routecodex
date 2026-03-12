import { Readable } from 'node:stream';
import type { AdapterContext } from '../../../../types/chat-envelope.js';
import type { JsonObject } from '../../../../types/json.js';
import type { StageRecorder } from '../../../../format-adapters/index.js';
import { defaultSseCodecRegistry, type SseProtocol } from '../../../../../../sse/index.js';
import { recordStage } from '../../../stages/utils.js';
import { isHubStageTimingDetailEnabled, logHubStageTiming } from '../../../hub-stage-timing.js';
import { ProviderProtocolError } from '../../../../../provider-protocol-error.js';
import {
  buildRespInboundSseErrorDescriptorWithNative,
  extractSseWrapperErrorWithNative,
  parseJsonObjectCandidateWithNative
} from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics.js';
import { tryDecodeJsonBodyFromStream } from './stream-json-sniffer.js';

type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat';

export interface RespInboundStage1SseDecodeOptions {
  providerProtocol: ProviderProtocol;
  payload: JsonObject;
  adapterContext: AdapterContext;
  wantsStream: boolean;
  stageRecorder?: StageRecorder;
}

export interface RespInboundStage1SseDecodeResult {
  payload: JsonObject;
  decodedFromSse: boolean;
}

function recordStage1SseDecode(
  stageRecorder: StageRecorder | undefined,
  payload: Record<string, unknown>
): void {
  // Keep stage1.sse_decode as a stable timeline checkpoint for both stream and non-stream responses.
  recordStage(stageRecorder, 'chat_process.resp.stage1.sse_decode', payload);
}

function extractDecodeStats(payload: JsonObject): Record<string, unknown> | undefined {
  const stats =
    payload && typeof payload === 'object'
      ? ((payload as Record<string, unknown>).__rccDecodeStats as Record<string, unknown> | undefined)
      : undefined;
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const key of [
    'chunkCount',
    'byteCount',
    'totalEvents',
    'contentBlocks',
    'toolUseBlocks',
    'thinkingBlocks',
    'textBlocks',
    'errors',
    'streamMs',
    'eventSpanMs',
    'parserMs',
    'builderMs',
    'messageStopSeen'
  ]) {
    const value = stats[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function resolveProviderType(protocol: ProviderProtocol): string | undefined {
  if (protocol === 'openai-chat') return 'openai';
  if (protocol === 'openai-responses') return 'responses';
  if (protocol === 'anthropic-messages') return 'anthropic';
  if (protocol === 'gemini-chat') return 'gemini';
  return undefined;
}

export async function runRespInboundStage1SseDecode(
  options: RespInboundStage1SseDecodeOptions
): Promise<RespInboundStage1SseDecodeResult> {
  const requestId = options.adapterContext.requestId || 'unknown';
  const forceDetailLog = isHubStageTimingDetailEnabled();
  // Transport compatibility: some HTTP clients return JSON bodies as plain strings when the upstream
  // mislabels `Content-Type`. Best-effort parse JSON text early so downstream format adapters and
  // semantic mappers always see canonical objects.
  logHubStageTiming(requestId, 'resp_inbound.stage1_text_json_probe', 'start', {
    providerProtocol: options.providerProtocol
  });
  const textProbeStart = Date.now();
  const maybeJsonText = tryDecodeJsonBodyFromText(options.payload as unknown);
  logHubStageTiming(requestId, 'resp_inbound.stage1_text_json_probe', 'completed', {
    elapsedMs: Date.now() - textProbeStart,
    providerProtocol: options.providerProtocol,
    matched: Boolean(maybeJsonText),
    forceLog: forceDetailLog
  });
  if (maybeJsonText) {
    recordStage1SseDecode(options.stageRecorder, {
      streamDetected: false,
      decoded: false,
      protocol: options.providerProtocol,
      reason: 'text_body_is_json'
    });
    return { payload: maybeJsonText, decodedFromSse: false };
  }

  logHubStageTiming(requestId, 'resp_inbound.stage1_wrapper_inspect', 'start');
  const wrapperInspectStart = Date.now();
  const wrapperError = extractSseWrapperErrorWithNative(options.payload as Record<string, unknown> | undefined);
  const stream = extractSseStream(options.payload);
  logHubStageTiming(requestId, 'resp_inbound.stage1_wrapper_inspect', 'completed', {
    elapsedMs: Date.now() - wrapperInspectStart,
    hasWrapperError: Boolean(wrapperError),
    hasStream: Boolean(stream),
    forceLog: forceDetailLog
  });
  // 某些 mock-provider / 捕获样本在 SSE 连接被异常终止时会携带 error 标记，
  // 即使仍保留 __sse_responses 流，也应视为上游异常并终止。
  if (wrapperError) {
    const nativeError = buildRespInboundSseErrorDescriptorWithNative({
      kind: 'wrapper_error',
      providerProtocol: options.providerProtocol,
      requestId: options.adapterContext.requestId,
      wrapperError
    });
    recordStage1SseDecode(options.stageRecorder, {
      streamDetected: Boolean(stream),
      decoded: false,
      protocol: options.providerProtocol,
      ...nativeError.stageRecord
    });
    throw new ProviderProtocolError(nativeError.errorMessage, {
      code: nativeError.code,
      protocol: nativeError.protocol,
      providerType: nativeError.providerType,
      details: nativeError.details
    });
  }

  if (!stream) {
    recordStage1SseDecode(options.stageRecorder, {
      streamDetected: false
    });
    return { payload: options.payload, decodedFromSse: false };
  }

  // Compatibility: when an upstream is asked for streaming but responds with a single JSON body
  // (common for mock servers and some OpenAI-compatible implementations), the provider wrapper may
  // still surface a Readable via `__sse_stream`. In that case we should treat it as JSON, not SSE.
  logHubStageTiming(requestId, 'resp_inbound.stage1_stream_json_probe', 'start');
  const streamProbeStart = Date.now();
  const maybeJson = await tryDecodeJsonBodyFromStream(stream);
  logHubStageTiming(requestId, 'resp_inbound.stage1_stream_json_probe', 'completed', {
    elapsedMs: Date.now() - streamProbeStart,
    matched: Boolean(maybeJson),
    forceLog: forceDetailLog
  });
  if (maybeJson) {
    recordStage1SseDecode(options.stageRecorder, {
      streamDetected: true,
      decoded: false,
      protocol: options.providerProtocol,
      reason: 'stream_body_is_json'
    });
    return { payload: maybeJson, decodedFromSse: false };
  }

  if (!supportsSseProtocol(options.providerProtocol)) {
    const nativeError = buildRespInboundSseErrorDescriptorWithNative({
      kind: 'protocol_unsupported',
      providerProtocol: options.providerProtocol,
      requestId: options.adapterContext.requestId
    });
    recordStage1SseDecode(options.stageRecorder, {
      streamDetected: true,
      decoded: false,
      protocol: options.providerProtocol,
      ...nativeError.stageRecord
    });
    throw new ProviderProtocolError(nativeError.errorMessage, {
      code: nativeError.code,
      protocol: nativeError.protocol,
      providerType: nativeError.providerType,
      details: nativeError.details
    });
  }

  try {
    const codec = defaultSseCodecRegistry.get(options.providerProtocol as SseProtocol);
    logHubStageTiming(requestId, 'resp_inbound.stage1_codec_decode', 'start', {
      providerProtocol: options.providerProtocol
    });
    const codecDecodeStart = Date.now();
    const decoded = (await codec.convertSseToJson(stream, {
      requestId: options.adapterContext.requestId,
      model: (options.adapterContext as Record<string, unknown>).modelId as string | undefined
    })) as JsonObject;
    const decodeStats = extractDecodeStats(decoded);
    logHubStageTiming(requestId, 'resp_inbound.stage1_codec_decode', 'completed', {
      elapsedMs: Date.now() - codecDecodeStart,
      providerProtocol: options.providerProtocol,
      forceLog: forceDetailLog,
      ...(decodeStats ?? {})
    });
    recordStage1SseDecode(options.stageRecorder, {
      streamDetected: true,
      decoded: true,
      protocol: options.providerProtocol
    });
    return { payload: decoded, decodedFromSse: true };
  } catch (error) {
    logHubStageTiming(requestId, 'resp_inbound.stage1_codec_decode', 'error', {
      message: error instanceof Error ? error.message : String(error ?? 'unknown'),
      providerProtocol: options.providerProtocol
    });
    const message = error instanceof Error ? error.message : String(error);
    const errRecord = error as Record<string, unknown>;
    const upstreamCode = typeof errRecord.code === 'string' ? errRecord.code : undefined;
    const upstreamContext =
      errRecord.context && typeof errRecord.context === 'object' && !Array.isArray(errRecord.context)
        ? (errRecord.context as Record<string, unknown>)
        : undefined;
    const nativeError = buildRespInboundSseErrorDescriptorWithNative({
      kind: 'decode_failure',
      providerProtocol: options.providerProtocol,
      requestId: options.adapterContext.requestId,
      message,
      upstreamCode,
      upstreamContext,
      adapterContext: options.adapterContext
    });
    recordStage1SseDecode(options.stageRecorder, {
      streamDetected: true,
      decoded: false,
      protocol: options.providerProtocol,
      ...nativeError.stageRecord
    });
    const providerError = new ProviderProtocolError(nativeError.errorMessage, {
      code: nativeError.code,
      protocol: nativeError.protocol,
      providerType: nativeError.providerType,
      details: nativeError.details
    }) as ProviderProtocolError & { status?: number };
    if (typeof nativeError.status === 'number') {
      providerError.status = nativeError.status;
    }
    throw providerError;
  }
}

function supportsSseProtocol(protocol: ProviderProtocol): protocol is SseProtocol {
  return protocol === 'openai-chat' || protocol === 'openai-responses' || protocol === 'anthropic-messages' || protocol === 'gemini-chat';
}

function tryDecodeJsonBodyFromText(payload: unknown): JsonObject | null {
  if (typeof payload !== 'string') {
    return null;
  }
  const parsed = parseJsonObjectCandidateWithNative(payload, 10 * 1024 * 1024);
  return (parsed as JsonObject | null) ?? null;
}

function extractSseStream(payload?: Record<string, unknown>): Readable | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const direct = (payload as any).__sse_responses || (payload as any).__sse_stream;
  if (direct && typeof (direct as any).pipe === 'function') {
    return direct as Readable;
  }
  const nested = (payload as any).data;
  if (nested && typeof nested === 'object') {
    const inner = (nested as any).__sse_responses || (nested as any).__sse_stream;
    if (inner && typeof (inner as any).pipe === 'function') {
      return inner as Readable;
    }
  }
  return undefined;
}
