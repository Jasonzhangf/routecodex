import { Readable } from 'node:stream';
import type { AdapterContext } from '../../../../types/chat-envelope.js';
import type { JsonObject } from '../../../../types/json.js';
import type { StageRecorder } from '../../../../format-adapters/index.js';
import { defaultSseCodecRegistry, type SseProtocol } from '../../../../../../sse/index.js';
import { recordStage } from '../../../stages/utils.js';
import { ProviderProtocolError } from '../../../../../provider-protocol-error.js';
import {
  extractContextLengthDiagnosticsWithNative,
  extractSseWrapperErrorWithNative,
  isContextLengthExceededSignalWithNative,
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

function resolveProviderType(protocol: ProviderProtocol): string | undefined {
  if (protocol === 'openai-chat') return 'openai';
  if (protocol === 'openai-responses') return 'responses';
  if (protocol === 'anthropic-messages') return 'anthropic';
  if (protocol === 'gemini-chat') return 'gemini';
  return undefined;
}

function readObjectFallback(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isRetryableNetworkSseDecodeFailure(message: string, upstreamCode?: string): boolean {
  const normalizedMessage = String(message || '').trim().toLowerCase();
  const normalizedUpstreamCode = typeof upstreamCode === 'string' ? upstreamCode.trim().toLowerCase() : '';
  return (
    normalizedMessage.includes('internal network failure') ||
    normalizedMessage.includes('network failure') ||
    normalizedMessage.includes('network error') ||
    normalizedMessage.includes('service unavailable') ||
    normalizedMessage.includes('temporarily unavailable') ||
    normalizedMessage.includes('timeout') ||
    normalizedUpstreamCode.includes('anthropic_sse_to_json_failed')
  );
}

export async function runRespInboundStage1SseDecode(
  options: RespInboundStage1SseDecodeOptions
): Promise<RespInboundStage1SseDecodeResult> {
  // Transport compatibility: some HTTP clients return JSON bodies as plain strings when the upstream
  // mislabels `Content-Type`. Best-effort parse JSON text early so downstream format adapters and
  // semantic mappers always see canonical objects.
  const maybeJsonText = tryDecodeJsonBodyFromText(options.payload as unknown);
  if (maybeJsonText) {
    recordStage(options.stageRecorder, 'chat_process.resp.stage1.sse_decode', {
      streamDetected: false,
      decoded: false,
      protocol: options.providerProtocol,
      reason: 'text_body_is_json'
    });
    return { payload: maybeJsonText, decodedFromSse: false };
  }

  const wrapperError = extractSseWrapperErrorWithNative(options.payload as Record<string, unknown> | undefined);
  const stream = extractSseStream(options.payload);
  // 某些 mock-provider / 捕获样本在 SSE 连接被异常终止时会携带 error 标记，
  // 即使仍保留 __sse_responses 流，也应视为上游异常并终止。
  if (wrapperError) {
    recordStage(options.stageRecorder, 'chat_process.resp.stage1.sse_decode', {
      streamDetected: Boolean(stream),
      decoded: false,
      protocol: options.providerProtocol,
      reason: 'sse_wrapper_error',
      error: wrapperError
    });
    throw new ProviderProtocolError(
      `[chat_process.resp.stage1.sse_decode] Upstream SSE terminated: ${wrapperError}`,
      {
        code: 'SSE_DECODE_ERROR',
        protocol: options.providerProtocol,
        providerType: resolveProviderType(options.providerProtocol),
        details: {
          phase: 'chat_process.resp.stage1.sse_decode',
          requestId: options.adapterContext.requestId,
          message: wrapperError
        }
      }
    );
  }

  if (!stream) {

    recordStage(options.stageRecorder, 'chat_process.resp.stage1.sse_decode', {
      streamDetected: false
    });
    return { payload: options.payload, decodedFromSse: false };
  }

  // Compatibility: when an upstream is asked for streaming but responds with a single JSON body
  // (common for mock servers and some OpenAI-compatible implementations), the provider wrapper may
  // still surface a Readable via `__sse_stream`. In that case we should treat it as JSON, not SSE.
  const maybeJson = await tryDecodeJsonBodyFromStream(stream);
  if (maybeJson) {
    recordStage(options.stageRecorder, 'chat_process.resp.stage1.sse_decode', {
      streamDetected: true,
      decoded: false,
      protocol: options.providerProtocol,
      reason: 'stream_body_is_json'
    });
    return { payload: maybeJson, decodedFromSse: false };
  }

  if (!supportsSseProtocol(options.providerProtocol)) {
    recordStage(options.stageRecorder, 'chat_process.resp.stage1.sse_decode', {
      streamDetected: true,
      decoded: false,
      reason: 'protocol_unsupported',
      protocol: options.providerProtocol
    });
    throw new ProviderProtocolError(
      `[chat_process.resp.stage1.sse_decode] Protocol ${options.providerProtocol} does not support SSE decoding`,
      {
        code: 'SSE_DECODE_ERROR',
        protocol: options.providerProtocol,
        providerType: resolveProviderType(options.providerProtocol),
        details: {
          phase: 'chat_process.resp.stage1.sse_decode',
          reason: 'protocol_unsupported'
        }
      }
    );
  }

  try {
    const codec = defaultSseCodecRegistry.get(options.providerProtocol as SseProtocol);
    const decoded = (await codec.convertSseToJson(stream, {
      requestId: options.adapterContext.requestId,
      model: (options.adapterContext as Record<string, unknown>).modelId as string | undefined
    })) as JsonObject;
    recordStage(options.stageRecorder, 'chat_process.resp.stage1.sse_decode', {
      streamDetected: true,
      decoded: true,
      protocol: options.providerProtocol
    });
    return { payload: decoded, decodedFromSse: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errRecord = error as Record<string, unknown>;
    const upstreamCode = typeof errRecord.code === 'string' ? errRecord.code : undefined;
    const upstreamContext = readObjectFallback(errRecord.context);
    const contextLengthExceeded = isContextLengthExceededSignalWithNative(upstreamCode, message, upstreamContext);
    const retryableNetworkFailure =
      !contextLengthExceeded &&
      options.providerProtocol === 'anthropic-messages' &&
      isRetryableNetworkSseDecodeFailure(message, upstreamCode);
    const diagnostics = extractContextLengthDiagnosticsWithNative(options.adapterContext);
    recordStage(options.stageRecorder, 'chat_process.resp.stage1.sse_decode', {
      streamDetected: true,
      decoded: false,
      protocol: options.providerProtocol,
      error: message,
      ...(upstreamCode ? { upstreamCode } : {}),
      ...(retryableNetworkFailure ? { statusCode: 502 } : {}),
      ...(contextLengthExceeded ? { reason: 'context_length_exceeded' } : {}),
      ...(Object.keys(diagnostics).length ? diagnostics : {})
    });
    throw new ProviderProtocolError(
      `[chat_process.resp.stage1.sse_decode] Failed to decode SSE payload for protocol ${options.providerProtocol}: ${message}` +
        (contextLengthExceeded ? ' (context too long; please compress conversation context and retry)' : ''),
      {
        code: retryableNetworkFailure ? 'HTTP_502' : 'SSE_DECODE_ERROR',
        protocol: options.providerProtocol,
        providerType: resolveProviderType(options.providerProtocol),
        details: {
          phase: 'chat_process.resp.stage1.sse_decode',
          requestId: options.adapterContext.requestId,
          message,
          ...(retryableNetworkFailure ? { statusCode: 502, status: 502, retryable: true } : {}),
          ...(upstreamCode ? { upstreamCode } : {}),
          ...(contextLengthExceeded ? { reason: 'context_length_exceeded' } : {}),
          ...(Object.keys(diagnostics).length ? diagnostics : {})
        }
      }
    );
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
