import type { PipelineExecutionInput, PipelineExecutionResult } from '../../../handlers/types.js';
// feature_id: server.provider_response_conversion_host
import type { ProviderHandle } from '../types.js';
import { asRecord } from '../provider-utils.js';
import {
  convertProviderResponse as bridgeConvertProviderResponse,
  createSnapshotRecorder as bridgeCreateSnapshotRecorder,
} from '../../../../modules/llmswitch/bridge.js';
import { isVerboseErrorLoggingEnabled } from './env-config.js';
import { logExecutorRuntimeNonBlockingWarning } from './servertool-runtime-log.js';
import { MetadataCenter } from '../metadata-center/metadata-center.js';
import { extractSseWrapperError } from './sse-error-handler.js';
import { isRateLimitLikeError } from './request-retry-helpers.js';
import { applyProviderConfiguredErrorMapping } from '../../../../providers/core/runtime/provider-configured-error-mapping.js';
import type { ProviderContext } from '../../../../providers/core/api/provider-types.js';
import type { ProviderErrorAugmented } from '../../../../providers/core/runtime/provider-error-types.js';
import {
  isEmptyOpenAiChatSseBridgeError,
  remapBridgeSseErrorToHttp
} from './provider-response-sse-error-normalizer.js';
import { extractUsageFromResult } from './usage-aggregator.js';
import { deriveFinishReason } from '../../../utils/finish-reason.js';
import { logPipelineStage } from '../../../utils/stage-logger.js';
import {
  readRuntimeControlProjection,
  readRuntimeDebugSnapshotProjection,
  readRuntimeServerToolProjection,
} from '../metadata-center/request-truth-readers.js';

import {
  asFlatRecord,
  findNestedRawString,
  findNestedErrorMarker,
  isGenericBridgeResponseContractError,
  isContextLengthExceededError,
  isRetryableNetworkSseWrapperError,
  extractBridgeProviderResponsePayload,
  TRUTHY_VALUES,
  FATAL_CONVERSION_ERROR_CODES,
  shouldAllowDirectResponsesPrebuiltSsePassthrough
} from './provider-response-shared-pure-blocks.js';

export function buildBridgeProviderResponseSeed(
  response: PipelineExecutionResult,
  body: unknown
): Record<string, unknown> | undefined {
  const responseRecord = response as unknown as Record<string, unknown>;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  if (
    responseRecord.data
    && typeof responseRecord.data === 'object'
    && !Array.isArray(responseRecord.data)
  ) {
    return responseRecord;
  }
  if (response.sseStream === undefined) {
    return undefined;
  }
  const seed: Record<string, unknown> = {
    sseStream: response.sseStream
  };
  if (typeof response.status === 'number') {
    seed.status = response.status;
  }
  if (response.headers && typeof response.headers === 'object' && !Array.isArray(response.headers)) {
    seed.headers = response.headers;
  }
  return seed;
}

function buildChoicesArrayBridgeDebugDetails(args: {
  message: string;
  bridgeProviderProtocol?: string;
  bridgeSeed?: Record<string, unknown>;
  bridgePayload?: Record<string, unknown>;
}): Record<string, unknown> {
  if (!args.message.toLowerCase().includes('choices array')) {
    return {};
  }
  const nestedData =
    args.bridgePayload?.data
    && typeof args.bridgePayload.data === 'object'
    && !Array.isArray(args.bridgePayload.data)
      ? (args.bridgePayload.data as Record<string, unknown>)
      : undefined;
  return {
    bridgeProviderProtocol: args.bridgeProviderProtocol,
    bridgeSeedKeys: args.bridgeSeed ? Object.keys(args.bridgeSeed) : undefined,
    bridgePayloadKeys: args.bridgePayload ? Object.keys(args.bridgePayload) : undefined,
    bridgePayloadHasChoices: Array.isArray(args.bridgePayload?.choices),
    bridgePayloadHasDataChoices: Array.isArray(nestedData?.choices)
  };
}

function buildBridgeAdapterContext(args: {
  metadata: Record<string, unknown>;
  requestId: string;
  entryEndpoint?: string;
  providerProtocol?: string;
  serverToolsEnabled?: boolean;
}): Record<string, unknown> {
  const context: Record<string, unknown> = {
    ...args.metadata,
    ...readRuntimeServerToolProjection(args.metadata),
    requestId: args.requestId,
    ...(args.entryEndpoint ? { entryEndpoint: args.entryEndpoint } : {}),
    ...(args.providerProtocol ? { providerProtocol: args.providerProtocol } : {}),
    ...(args.serverToolsEnabled !== undefined ? { serverToolsEnabled: args.serverToolsEnabled } : {}),
  };
  const center = MetadataCenter.read(args.metadata);
  if (center) {
    MetadataCenter.bind(context, center);
  }
  return context;
}

function attachTimingBreakdown(response: PipelineExecutionResult): PipelineExecutionResult {
  const clientInjectWaitMsRaw = response.usageLogInfo?.clientInjectWaitMs;
  const clientInjectWaitMs =
    typeof clientInjectWaitMsRaw === 'number' && Number.isFinite(clientInjectWaitMsRaw)
      ? Math.max(0, Math.floor(clientInjectWaitMsRaw))
      : undefined;
  if (clientInjectWaitMs === undefined) {
    return response;
  }
  return {
    ...response,
    timingBreakdown: {
      ...(response.timingBreakdown ?? {}),
      clientInjectWaitMs,
      hubResponseExcludedMs: response.timingBreakdown?.hubResponseExcludedMs ?? clientInjectWaitMs
    }
  };
}

function logProviderResponseConverterNonBlockingError(
  stage: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  logExecutorRuntimeNonBlockingWarning({
    namespace: 'provider-response-converter',
    stage,
    error,
    details,
    throttleKey: stage
  });
}

function isRecoverableSseDecodeBridgeError(error: Record<string, unknown>): boolean {
  return error.requestExecutorProviderErrorStage === 'provider.sse_decode' && error.retryable === true;
}

function shouldEnableHubStageRecorder(): boolean {
  const raw = String(
    process.env.ROUTECODEX_ENABLE_HUB_STAGE_RECORDER
    ?? process.env.RCC_ENABLE_HUB_STAGE_RECORDER
    ?? ""
  ).trim().toLowerCase();
  return TRUTHY_VALUES.has(raw);
}

function readRuntimeControlForProviderResponseConverter(
  metadata?: Record<string, unknown>
): { providerProtocol?: string } {
  const runtimeControl = readRuntimeControlProjection(metadata);
  return {
    providerProtocol: runtimeControl.providerProtocol
  };
}

function readProviderProtocolForProviderResponseConverter(metadata?: Record<string, unknown>): string {
  const providerProtocol = readRuntimeControlForProviderResponseConverter(
    metadata
  ).providerProtocol;
  if (providerProtocol) {
    return providerProtocol;
  }
  throw new Error('Provider response converter requires metadata center runtime_control.providerProtocol');
}

export function buildResponseMetadataBagForProviderResponseConverter(args: {
  metadata?: Record<string, unknown>;
  providerFamily?: string;
}): Record<string, unknown> {
  const metadataBag = asRecord(args.metadata) ?? {};
  const providerFamily = typeof args.providerFamily === 'string' ? args.providerFamily.trim() : '';
  if (!providerFamily) {
    return metadataBag;
  }
  const responseMetadataBag: Record<string, unknown> = {
    ...metadataBag,
    providerFamily
  };
  const metadataCenter = MetadataCenter.read(metadataBag);
  if (metadataCenter) {
    MetadataCenter.bind(responseMetadataBag, metadataCenter);
  }
  return responseMetadataBag;
}

export type ConvertProviderResponseOptions = {
  entryEndpoint?: string;
  providerProtocol: string;
  providerType?: string;
  providerFamily?: string;
  providerKey?: string;
  requestId: string;
  serverToolsEnabled?: boolean;
  wantsStream: boolean;
  entryOriginRequest?: Record<string, unknown> | undefined;
  processMode?: string;
  response: PipelineExecutionResult;
  pipelineMetadata?: Record<string, unknown>;
};

export type ConvertProviderResponseDeps = {
  runtimeManager: {
    resolveRuntimeKey(providerKey?: string): string | undefined;
    getHandleByRuntimeKey(runtimeKey?: string): ProviderHandle | undefined;
  };
  executeNested(input: PipelineExecutionInput): Promise<PipelineExecutionResult>;
};

function buildProviderContextForResponseConversion(
  options: ConvertProviderResponseOptions,
  deps: ConvertProviderResponseDeps
): ProviderContext {
  const runtimeKey = deps.runtimeManager.resolveRuntimeKey(options.providerKey);
  const handle = deps.runtimeManager.getHandleByRuntimeKey(runtimeKey);
  const runtimeExtensions = asRecord(handle?.runtime?.extensions);
  const metadataExtensions = asRecord(options.pipelineMetadata?.extensions);
  const extensions = runtimeExtensions ?? metadataExtensions;
  const runtimeMetadata = {
    ...(asRecord(options.pipelineMetadata) ?? {}),
    ...(extensions ? { extensions } : {})
  };
  const providerProtocol = readProviderProtocolForProviderResponseConverter(runtimeMetadata);
  return {
    requestId: options.requestId,
    providerType: (options.providerType || 'unknown') as ProviderContext['providerType'],
    providerFamily: options.providerFamily,
    providerKey: options.providerKey,
    providerProtocol,
    startTime: Date.now(),
    runtimeMetadata,
    extensions,
    ...(handle?.runtime ? { target: handle.runtime as unknown as ProviderContext['target'] } : {})
  };
}

export async function convertProviderResponseIfNeeded(
  options: ConvertProviderResponseOptions,
  deps: ConvertProviderResponseDeps
): Promise<PipelineExecutionResult> {
  let body = options.response.body;
  let bridgeSeedForError: Record<string, unknown> | undefined;
  let bridgePayloadForError: Record<string, unknown> | undefined;
  let bridgeProviderProtocolForError: string | undefined;
  if (body && typeof body === 'object') {
    const wrapperError = extractSseWrapperError(body as Record<string, unknown>);
    if (wrapperError) {
      const codeSuffix = wrapperError.errorCode ? ` [${wrapperError.errorCode}]` : '';
      const error = new Error(`Upstream SSE error event${codeSuffix}: ${wrapperError.message}`) as ProviderErrorAugmented & {
        code?: string;
        status?: number;
        statusCode?: number;
        retryable?: boolean;
        upstreamCode?: string;
        requestExecutorProviderErrorStage?: string;
      };
      error.code = 'SSE_DECODE_ERROR';
      error.requestExecutorProviderErrorStage = 'provider.sse_decode';
      error.response = {
        data: {
          error: {
            code: wrapperError.errorCode,
            message: wrapperError.upstreamError?.message ?? wrapperError.message,
            status: wrapperError.statusCode,
            type: wrapperError.upstreamError?.type,
            param: wrapperError.upstreamError?.param
          }
        },
        status: wrapperError.statusCode
      };
      if (wrapperError.errorCode) {
        error.upstreamCode = wrapperError.errorCode;
      }
      error.retryable = wrapperError.retryable;
      if (typeof wrapperError.statusCode === 'number' && Number.isFinite(wrapperError.statusCode)) {
        error.status = wrapperError.statusCode;
        error.statusCode = wrapperError.statusCode;
      }
      const isContextLengthExceeded = isContextLengthExceededError(wrapperError.message, wrapperError.errorCode);
      if (isContextLengthExceeded) {
        error.code = 'CONTEXT_LENGTH_EXCEEDED';
        error.status = 400;
        error.statusCode = 400;
        error.retryable = false;
        if (typeof error.upstreamCode !== 'string' || !error.upstreamCode.trim()) {
          error.upstreamCode = wrapperError.errorCode || 'context_length_exceeded';
        }
      }
      if (!isContextLengthExceeded && isRateLimitLikeError(wrapperError.message, wrapperError.errorCode)) {
        error.code = 'HTTP_429';
        error.status = 429;
        error.statusCode = 429;
        error.retryable = true;
      } else if (
        !isContextLengthExceeded &&
        isRetryableNetworkSseWrapperError(wrapperError.message, wrapperError.errorCode, wrapperError.statusCode)
      ) {
        error.code = 'HTTP_502';
        error.status = 502;
        error.statusCode = 502;
        error.retryable = true;
      } else if (wrapperError.retryable && error.statusCode === undefined) {
        error.status = 503;
        error.statusCode = 503;
      }
      const mappedStatus = applyProviderConfiguredErrorMapping({
        normalized: error,
        context: buildProviderContextForResponseConversion(options, deps),
        statusCode: error.statusCode ?? error.status
      });
      if (mappedStatus !== undefined) {
        error.retryable = mappedStatus === 429 || error.retryable;
      }
      throw error;
    }
  }
  const entry = (options.entryEndpoint || '').toLowerCase();
  const needsAnthropicConversion = entry.includes('/v1/messages');
  const needsResponsesConversion = entry.includes('/v1/responses');
  const needsChatConversion = entry.includes('/v1/chat/completions');
  if (!needsAnthropicConversion && !needsResponsesConversion && !needsChatConversion) {
    return options.response;
  }
  const responseMetadataBag = buildResponseMetadataBagForProviderResponseConverter({
    metadata: asRecord(options.pipelineMetadata),
    providerFamily: options.providerFamily
  });
  const effectiveProviderProtocol = readProviderProtocolForProviderResponseConverter(responseMetadataBag);
  const bridgeProviderResponseSeed = buildBridgeProviderResponseSeed(options.response, body);
  if (!bridgeProviderResponseSeed) {
    return options.response;
  }
  bridgeSeedForError = bridgeProviderResponseSeed;
  body = bridgeProviderResponseSeed;
  const isDirectResponsesPrebuiltSsePassthrough = shouldAllowDirectResponsesPrebuiltSsePassthrough({
    entryEndpoint: options.entryEndpoint || entry,
    providerProtocol: effectiveProviderProtocol,
    hasSseStream: options.response.sseStream !== undefined,
    continuationOwner: options.response.continuationOwner
  });
  if (isDirectResponsesPrebuiltSsePassthrough) {
    logPipelineStage('convert.bridge.prebuilt_sse_passthrough', options.requestId, {
      entryEndpoint: options.entryEndpoint || entry,
      providerProtocol: effectiveProviderProtocol,
      continuationOwner: options.response.continuationOwner
    });
    return options.response;
  }
  try {
    const adapterContext = buildBridgeAdapterContext({
      metadata: responseMetadataBag,
      requestId: options.requestId,
      entryEndpoint: options.entryEndpoint || entry,
      providerProtocol: effectiveProviderProtocol,
      serverToolsEnabled: options.serverToolsEnabled !== false
    });
    const bridgeProviderProtocol = effectiveProviderProtocol;
    const serverToolsEnabled = options.serverToolsEnabled !== false;
    let stageRecorder: unknown;
    if (shouldEnableHubStageRecorder()) {
      logPipelineStage('convert.snapshot_recorder.start', options.requestId, {
        entryEndpoint: options.entryEndpoint || entry,
        providerProtocol: bridgeProviderProtocol
      });
      const snapshotRecorderStartMs = Date.now();
      stageRecorder = await bridgeCreateSnapshotRecorder(
        adapterContext,
        options.entryEndpoint || entry
      );
      logPipelineStage('convert.snapshot_recorder.completed', options.requestId, {
        entryEndpoint: options.entryEndpoint || entry,
        providerProtocol: bridgeProviderProtocol,
        elapsedMs: Date.now() - snapshotRecorderStartMs
      });
    }

    logPipelineStage('convert.bridge.start', options.requestId, {
      entryEndpoint: options.entryEndpoint || entry,
      providerProtocol: bridgeProviderProtocol,
      wantsStream: options.wantsStream
    });
    const bridgeStartMs = Date.now();
    const bridgeProviderResponse =
      extractBridgeProviderResponsePayload(bridgeProviderResponseSeed)
      ?? bridgeProviderResponseSeed;
    bridgePayloadForError = bridgeProviderResponse;
    bridgeProviderProtocolForError = bridgeProviderProtocol;
    const converted = await bridgeConvertProviderResponse({
      providerProtocol: bridgeProviderProtocol,
      providerResponse: bridgeProviderResponse,
      context: adapterContext,
      entryEndpoint: options.entryEndpoint || entry,
      wantsStream: options.wantsStream,
      stageRecorder
    });
    logPipelineStage('convert.bridge.completed', options.requestId, {
      entryEndpoint: options.entryEndpoint || entry,
      providerProtocol: bridgeProviderProtocol,
      hasSse: Boolean(converted.sseStream),
      hasBody: converted.body !== undefined && converted.body !== null,
      elapsedMs: Date.now() - bridgeStartMs
    });
    if (converted.sseStream) {
      const usage = converted.body
        ? extractUsageFromResult(
          { body: converted.body },
          {
            providerProtocol: bridgeProviderProtocol,
            providerType: options.providerType,
            providerKey: options.providerKey
          }
        )
        : undefined;
      const finishReason = deriveFinishReason(converted.body);
      logPipelineStage('convert.sse_wrapper_detected', options.requestId, {
        hasUsage: Boolean(usage),
        finishReason
      });
      return attachTimingBreakdown({
        ...options.response,
        body: converted.body,
        sseStream: converted.sseStream,
        usageLogInfo: {
          ...(options.response.usageLogInfo ?? {}),
          requestStartedAtMs: options.response.usageLogInfo?.requestStartedAtMs ?? Date.now(),
          ...(usage ? { usage: usage as Record<string, unknown> } : {})
        }
      });
    }
    void deriveFinishReason(converted.body ?? body);
    return attachTimingBreakdown({
      ...options.response,
      body: converted.body ?? body
    });
  } catch (error) {
    const err = error as Error | unknown;
    const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');
    const errRecord = err as Record<string, unknown>;
    const errCode = typeof errRecord.code === 'string' ? errRecord.code : undefined;
    const upstreamCode = typeof errRecord.upstreamCode === 'string' ? errRecord.upstreamCode : undefined;
    const errName = typeof errRecord.name === 'string' ? errRecord.name : undefined;
    const requestExecutorProviderErrorStage =
      typeof errRecord.requestExecutorProviderErrorStage === 'string'
        ? errRecord.requestExecutorProviderErrorStage
        : undefined;
    const detailRecord = asRecord(errRecord.details);
    const detailUpstreamCode =
      typeof (detailRecord as Record<string, unknown> | undefined)?.upstreamCode === 'string'
        ? String((detailRecord as Record<string, unknown>).upstreamCode)
        : undefined;
    const detailReason =
      typeof (detailRecord as Record<string, unknown> | undefined)?.reason === 'string'
        ? String((detailRecord as Record<string, unknown>).reason)
        : typeof (detailRecord as Record<string, unknown> | undefined)?.error === 'string'
          ? String((detailRecord as Record<string, unknown>).error)
        : undefined;
    const validationReason =
      typeof errRecord.validationReason === 'string'
        ? errRecord.validationReason
        : typeof detailRecord?.validationReason === 'string'
          ? detailRecord.validationReason
          : undefined;
    const validationMessage =
      typeof errRecord.validationMessage === 'string'
        ? errRecord.validationMessage
        : typeof detailRecord?.validationMessage === 'string'
          ? detailRecord.validationMessage
          : undefined;
    const missingFields = Array.isArray(errRecord.missingFields)
      ? (errRecord.missingFields.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))
      : Array.isArray(detailRecord?.missingFields)
        ? ((detailRecord.missingFields as unknown[]).filter((value): value is string => typeof value === 'string' && value.trim().length > 0))
        : undefined;
    const normalizedUpstreamCode = (upstreamCode || detailUpstreamCode || '').trim().toLowerCase();
    const fatalConversionCode =
      (typeof errCode === 'string' && FATAL_CONVERSION_ERROR_CODES.has(errCode) ? errCode : undefined)
      ?? (typeof upstreamCode === 'string' && FATAL_CONVERSION_ERROR_CODES.has(upstreamCode) ? upstreamCode : undefined)
      ?? (typeof detailUpstreamCode === 'string' && FATAL_CONVERSION_ERROR_CODES.has(detailUpstreamCode) ? detailUpstreamCode : undefined);

    if (fatalConversionCode) {
      logPipelineStage('convert.bridge.error', options.requestId, {
        code: errCode,
        upstreamCode: upstreamCode || detailUpstreamCode,
        reason: detailReason,
        message,
        ...buildChoicesArrayBridgeDebugDetails({
          message,
          bridgeProviderProtocol: bridgeProviderProtocolForError,
          bridgeSeed: bridgeSeedForError,
          bridgePayload: bridgePayloadForError
        })
      });
      throw error;
    }
    const isSseDecodeError =
      errCode === 'SSE_DECODE_ERROR' ||
      errCode === 'HTTP_502' ||
      errCode === 'HTTP_429' ||
      isEmptyOpenAiChatSseBridgeError(message) ||
      (errName === 'ProviderProtocolError' && message.toLowerCase().includes('sse'));
    const normalizedMessage = message.toLowerCase();
    const isContextLengthExceeded = isContextLengthExceededError(
      normalizedMessage,
      upstreamCode || detailUpstreamCode,
      detailReason
    );

    if (isGenericBridgeResponseContractError({ error: errRecord, message })) {
      errRecord.requestExecutorProviderErrorStage = 'host.response_contract';
    }

    const effectiveErrorStage =
      typeof errRecord.requestExecutorProviderErrorStage === 'string'
        ? errRecord.requestExecutorProviderErrorStage
        : typeof detailRecord?.requestExecutorProviderErrorStage === 'string'
          ? detailRecord.requestExecutorProviderErrorStage
          : requestExecutorProviderErrorStage;
    if (isSseDecodeError || isContextLengthExceeded) {
      if (isSseDecodeError && errRecord) {
        errRecord.requestExecutorProviderErrorStage = 'provider.sse_decode';
      }
      remapBridgeSseErrorToHttp(errRecord, message);
      const bridgeErrorStage = isRecoverableSseDecodeBridgeError(errRecord)
        ? 'convert.bridge.recoverable'
        : 'convert.bridge.error';
      logPipelineStage(bridgeErrorStage, options.requestId, {
        code: typeof errRecord.code === 'string' ? errRecord.code : errCode,
        upstreamCode:
          typeof errRecord.upstreamCode === 'string'
            ? errRecord.upstreamCode
            : upstreamCode || detailUpstreamCode,
        reason: detailReason,
        message
      });
      if (isVerboseErrorLoggingEnabled()) {
        console.error(
          '[RequestExecutor] Fatal conversion error, bubbling as HTTP error',
          error
        );
      }
      throw error;
    }

    logPipelineStage('convert.bridge.error', options.requestId, {
      code: errCode,
      upstreamCode: upstreamCode || detailUpstreamCode,
      reason: detailReason,
      message,
      ...buildChoicesArrayBridgeDebugDetails({
        message,
        bridgeProviderProtocol: bridgeProviderProtocolForError,
        bridgeSeed: bridgeSeedForError,
        bridgePayload: bridgePayloadForError
      })
    });
    if (isVerboseErrorLoggingEnabled()) {
      console.error('[RequestExecutor] Failed to convert provider response via llmswitch-core', error);
    }
    throw error;
  }
}
