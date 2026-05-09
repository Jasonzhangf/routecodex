import type { PipelineExecutionInput, PipelineExecutionResult } from '../../../handlers/types.js';
import type { ProviderHandle } from '../types.js';
import { asRecord } from '../provider-utils.js';
import {
  parseToolArgsRecord,
  validateCanonicalClientToolCall,
  isImagePathLike,
  buildMissingFields,
  containsBroadKillCommand
} from './provider-response-tool-validation-blocks.js';
import {
  convertProviderResponse as bridgeConvertProviderResponse,
  createSnapshotRecorder as bridgeCreateSnapshotRecorder
} from '../../../../modules/llmswitch/bridge.js';
import {
  normalizeProviderResponse
} from './provider-response-utils.js';
import { isVerboseErrorLoggingEnabled } from './env-config.js';
import { logExecutorRuntimeNonBlockingWarning } from './servertool-runtime-log.js';
import { extractSseWrapperError } from './sse-error-handler.js';
import { isRateLimitLikeError } from './request-retry-helpers.js';
import { extractUsageFromResult } from './usage-aggregator.js';
import { deriveFinishReason } from '../../../utils/finish-reason.js';
import { logPipelineStage } from '../../../utils/stage-logger.js';
import {
  buildServerToolSseWrapperBody
} from './servertool-response-normalizer.js';
import {
  buildServerToolAdapterContext
} from './servertool-adapter-context.js';
import {
  executeServerToolClientInjectDispatch,
  executeServerToolReenterPipeline
} from './servertool-followup-dispatch.js';
import {
  compactFollowupLogReason,
  extractServerToolFollowupErrorLogDetails,
  finalizeServerToolBridgeConvertError
} from './servertool-followup-error.js';

import {
  asFlatRecord,
  tryParseJsonLikeString,
  hasStoplessDirectiveInRequestPayload,
  collectDeclaredToolNames,
  findNestedRawString,
  findNestedErrorMarker,
  normalizeRecoveredToolCalls,
  stringifyToolCallArgumentsForValidation,
  validateConvertedProviderToolCallsOrThrow,
  isGenericBridgeResponseContractError,
  isContextLengthExceededError,
  isRetryableNetworkSseWrapperError,
  extractBridgeProviderResponsePayload,
  TRUTHY_VALUES,
  FATAL_CONVERSION_ERROR_CODES,
  STOPLESS_DIRECTIVE_PATTERN
} from './provider-response-shared-pure-blocks.js';
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

function shouldEnableHubStageRecorder(): boolean {
  const raw = String(
    process.env.ROUTECODEX_ENABLE_HUB_STAGE_RECORDER
    ?? process.env.RCC_ENABLE_HUB_STAGE_RECORDER
    ?? ""
  ).trim().toLowerCase();
  return TRUTHY_VALUES.has(raw);
}
function remapBridgeSseErrorToHttp(error: Record<string, unknown>, message: string): void {
  const detailRecord = asRecord(error.details);
  const upstreamCode =
    typeof error.upstreamCode === 'string'
      ? error.upstreamCode
      : typeof detailRecord?.upstreamCode === 'string'
        ? detailRecord.upstreamCode
        : undefined;
  const detailReason = typeof detailRecord?.reason === 'string' ? detailRecord.reason : undefined;
  const statusCodeRaw =
    typeof error.statusCode === 'number'
      ? error.statusCode
      : typeof error.status === 'number'
        ? error.status
        : typeof detailRecord?.statusCode === 'number'
          ? detailRecord.statusCode
          : undefined;
  const isContextLengthExceeded = isContextLengthExceededError(message, upstreamCode, detailReason);
  if (isContextLengthExceeded) {
    (error as any).status = 400;
    (error as any).statusCode = 400;
    (error as any).retryable = false;
    (error as any).code = 'CONTEXT_LENGTH_EXCEEDED';
    if (typeof error.upstreamCode !== 'string' || !String(error.upstreamCode).trim()) {
      (error as any).upstreamCode = upstreamCode || 'context_length_exceeded';
    }
    return;
  }
  if (isRateLimitLikeError(message, String(error.code || ''), upstreamCode)) {
    (error as any).status = 429;
    (error as any).statusCode = 429;
    (error as any).retryable = true;
    (error as any).code = 'HTTP_429';
    return;
  }
  if (isRetryableNetworkSseWrapperError(message, upstreamCode, statusCodeRaw)) {
    (error as any).status = 502;
    (error as any).statusCode = 502;
    (error as any).retryable = true;
    (error as any).code = 'HTTP_502';
  }
}

function syncHubStageTopBackToPipelineMetadata(options: {
  pipelineMetadata?: Record<string, unknown>;
  adapterContext: Record<string, unknown>;
}): void {
  const pipelineMetadata = asRecord(options.pipelineMetadata);
  if (!pipelineMetadata) {
    return;
  }
  const adapterRt = asRecord((options.adapterContext as Record<string, unknown>).__rt);
  if (!adapterRt || !Array.isArray(adapterRt.hubStageTop) || adapterRt.hubStageTop.length === 0) {
    return;
  }
  const metadataRt = asRecord((pipelineMetadata as Record<string, unknown>).__rt) ?? {};
  (pipelineMetadata as Record<string, unknown>).__rt = {
    ...metadataRt,
    hubStageTop: adapterRt.hubStageTop
  };
}

export type ConvertProviderResponseOptions = {
  entryEndpoint?: string;
  providerProtocol: string;
  providerType?: string;
  requestId: string;
  serverToolsEnabled?: boolean;
  wantsStream: boolean;
  originalRequest?: Record<string, unknown> | undefined;
  requestSemantics?: Record<string, unknown> | undefined;
  processMode?: string;
  response: PipelineExecutionResult;
  pipelineMetadata?: Record<string, unknown>;
};

export type ConvertProviderResponseDeps = {
  runtimeManager: {
    resolveRuntimeKey(providerKey?: string, fallback?: string): string | undefined;
    getHandleByRuntimeKey(runtimeKey?: string): ProviderHandle | undefined;
  };
  executeNested(input: PipelineExecutionInput): Promise<PipelineExecutionResult>;
};

export async function convertProviderResponseIfNeeded(
  options: ConvertProviderResponseOptions,
  deps: ConvertProviderResponseDeps
): Promise<PipelineExecutionResult> {
  const body = options.response.body;
  if (body && typeof body === 'object') {
    const wrapperError = extractSseWrapperError(body as Record<string, unknown>);
    if (wrapperError) {
      const codeSuffix = wrapperError.errorCode ? ` [${wrapperError.errorCode}]` : '';
      const error = new Error(`Upstream SSE error event${codeSuffix}: ${wrapperError.message}`) as Error & {
        code?: string;
        status?: number;
        statusCode?: number;
        retryable?: boolean;
        upstreamCode?: string;
        requestExecutorProviderErrorStage?: string;
      };
      error.code = 'SSE_DECODE_ERROR';
      error.requestExecutorProviderErrorStage = 'provider.sse_decode';
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
      throw error;
    }
  }
  if (options.processMode === 'passthrough' && !options.wantsStream && options.serverToolsEnabled === false) {
    return options.response;
  }
  const entry = (options.entryEndpoint || '').toLowerCase();
  const needsAnthropicConversion = entry.includes('/v1/messages');
  const needsResponsesConversion = entry.includes('/v1/responses');
  const needsChatConversion = entry.includes('/v1/chat/completions');
  if (!needsAnthropicConversion && !needsResponsesConversion && !needsChatConversion) {
    return options.response;
  }
  if (!body || typeof body !== 'object') {
    return options.response;
  }
  let clientInjectWaitMs = 0;
  const attachTimingBreakdown = (result: PipelineExecutionResult): PipelineExecutionResult => {
    if (!(clientInjectWaitMs > 0)) {
      return result;
    }
    const existing = result.timingBreakdown;
    const nextClientInjectWaitMs = Math.max(
      0,
      Math.floor((existing?.clientInjectWaitMs ?? 0) + clientInjectWaitMs)
    );
    const nextHubResponseExcludedMs = Math.max(
      0,
      Math.floor((existing?.hubResponseExcludedMs ?? 0) + clientInjectWaitMs)
    );
    return {
      ...result,
      timingBreakdown: {
        ...existing,
        clientInjectWaitMs: nextClientInjectWaitMs,
        hubResponseExcludedMs: nextHubResponseExcludedMs
      }
    };
  };
  let adapterContext: Record<string, unknown> | undefined;
  try {
    const metadataBag = asRecord(options.pipelineMetadata);
    const baseContext = buildServerToolAdapterContext({
      metadata: metadataBag,
      originalRequest: options.originalRequest,
      requestSemantics: options.requestSemantics,
      requestId: options.requestId,
      entryEndpoint: options.entryEndpoint || entry,
      providerProtocol: options.providerProtocol,
      serverToolsEnabled: options.serverToolsEnabled !== false,
      onReasoningStopSeedError: (error) => {
        logProviderResponseConverterNonBlockingError(
          'seedReasoningStopStateFromCapturedRequest',
          error
        );
      }
    });
    adapterContext = baseContext;
    const serverToolsEnabled = options.serverToolsEnabled !== false;
    let stageRecorder: unknown;
    if (shouldEnableHubStageRecorder()) {
      logPipelineStage('convert.snapshot_recorder.start', options.requestId, {
        entryEndpoint: options.entryEndpoint || entry,
        providerProtocol: options.providerProtocol
      });
      const snapshotRecorderStartMs = Date.now();
      stageRecorder = await bridgeCreateSnapshotRecorder(
        adapterContext,
        typeof (adapterContext as Record<string, unknown>).entryEndpoint === 'string'
          ? ((adapterContext as Record<string, unknown>).entryEndpoint as string)
          : options.entryEndpoint || entry
      );
      logPipelineStage('convert.snapshot_recorder.completed', options.requestId, {
        entryEndpoint: options.entryEndpoint || entry,
        providerProtocol: options.providerProtocol,
        elapsedMs: Date.now() - snapshotRecorderStartMs
      });
    }

    const providerInvoker = async (invokeOptions: {
      providerKey: string;
      providerType?: string;
      modelId?: string;
      providerProtocol: string;
      payload: Record<string, unknown>;
      entryEndpoint: string;
      requestId: string;
      routeHint?: string;
    }): Promise<{ providerResponse: Record<string, unknown> }> => {
      const providerInvokeStartMs = Date.now();
      logPipelineStage('convert.provider_invoke.start', invokeOptions.requestId, {
        providerKey: invokeOptions.providerKey,
        providerProtocol: invokeOptions.providerProtocol,
        routeHint: invokeOptions.routeHint
      });
      if (invokeOptions.routeHint) {
        const carrier = invokeOptions.payload as { metadata?: Record<string, unknown> };
        const existingMeta =
          carrier.metadata && typeof carrier.metadata === 'object'
            ? (carrier.metadata as Record<string, unknown>)
            : {};
        carrier.metadata = {
          ...existingMeta,
          routeHint: existingMeta.routeHint ?? invokeOptions.routeHint
        };
      }

      const runtimeKey = deps.runtimeManager.resolveRuntimeKey(invokeOptions.providerKey);
      if (!runtimeKey) {
        throw new Error(`Runtime for provider ${invokeOptions.providerKey} not initialized`);
      }
      logPipelineStage('convert.provider_invoke.runtime_resolved', invokeOptions.requestId, {
        providerKey: invokeOptions.providerKey,
        runtimeKey
      });
      const handle = deps.runtimeManager.getHandleByRuntimeKey(runtimeKey);
      if (!handle) {
        throw new Error(`Provider runtime ${runtimeKey} not found`);
      }
      logPipelineStage('convert.provider_invoke.send.start', invokeOptions.requestId, {
        providerKey: invokeOptions.providerKey,
        runtimeKey
      });
      const providerSendStartMs = Date.now();
      const providerResponse = await handle.instance.processIncoming(invokeOptions.payload);
      logPipelineStage('convert.provider_invoke.send.completed', invokeOptions.requestId, {
        providerKey: invokeOptions.providerKey,
        runtimeKey,
        elapsedMs: Date.now() - providerSendStartMs
      });
      const normalizeStartMs = Date.now();
      const normalized = normalizeProviderResponse(providerResponse);
      logPipelineStage('convert.provider_invoke.normalize.completed', invokeOptions.requestId, {
        providerKey: invokeOptions.providerKey,
        runtimeKey,
        status: normalized.status,
        elapsedMs: Date.now() - normalizeStartMs
      });
      const normalizedBodyRecord =
        normalized.body && typeof normalized.body === 'object'
          ? (normalized.body as Record<string, unknown>)
          : undefined;
      const bodyPayload =
        extractBridgeProviderResponsePayload(normalizedBodyRecord)
        ?? (normalizedBodyRecord
          ? normalizedBodyRecord
          : (normalized as unknown as Record<string, unknown>));
      logPipelineStage('convert.provider_invoke.completed', invokeOptions.requestId, {
        providerKey: invokeOptions.providerKey,
        runtimeKey,
        elapsedMs: Date.now() - providerInvokeStartMs
      });
      return { providerResponse: bodyPayload };
    };

    const reenterPipeline = async (reenterOpts: {
      entryEndpoint: string;
      requestId: string;
      body: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    }): Promise<{ body?: Record<string, unknown>; __sse_responses?: unknown; format?: string }> => {
      const reenterStartMs = Date.now();
      const nestedEntry = reenterOpts.entryEndpoint || options.entryEndpoint || entry;
      logPipelineStage('convert.reenter.start', reenterOpts.requestId, {
        entryEndpoint: nestedEntry
      });
      const nestedResult = await executeServerToolReenterPipeline({
        entryEndpoint: reenterOpts.entryEndpoint,
        fallbackEntryEndpoint: options.entryEndpoint || entry,
        requestId: reenterOpts.requestId,
        body: reenterOpts.body,
        metadata: reenterOpts.metadata,
        baseMetadata: metadataBag,
        requestSemantics: options.requestSemantics,
        executeNested: deps.executeNested,
        runClientInjectBeforeNested: false,
        onMergeRuntimeMetaError: (error, details) => {
          logProviderResponseConverterNonBlockingError('reenter.buildNestedMetadata.mergeRuntimeMeta', error, {
            requestId: details.requestId,
            entryEndpoint: details.entryEndpoint
          });
        }
      });
      logPipelineStage('convert.reenter.completed', reenterOpts.requestId, {
        entryEndpoint: nestedEntry,
        elapsedMs: Date.now() - reenterStartMs
      });
      return nestedResult;
    };

    const clientInjectDispatch = async (injectOpts: {
      entryEndpoint: string;
      requestId: string;
      body?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    }): Promise<{ ok: boolean; reason?: string }> => {
      const clientInjectAttemptStartedAt = Date.now();
      const clientInjectStartMs = Date.now();
      logPipelineStage('convert.client_inject.start', injectOpts.requestId, {
        entryEndpoint: injectOpts.entryEndpoint || options.entryEndpoint || entry
      });
      const nestedEntry = injectOpts.entryEndpoint || options.entryEndpoint || entry;
      const injectResult = await executeServerToolClientInjectDispatch({
        entryEndpoint: injectOpts.entryEndpoint,
        fallbackEntryEndpoint: options.entryEndpoint || entry,
        requestId: injectOpts.requestId,
        body: injectOpts.body,
        metadata: injectOpts.metadata,
        baseMetadata: metadataBag,
        requestSemantics: options.requestSemantics,
        onMergeRuntimeMetaError: (error, details) => {
          logProviderResponseConverterNonBlockingError('clientInjectDispatch.mergeRuntimeMeta', error, {
            requestId: details.requestId,
            entryEndpoint: details.entryEndpoint
          });
        }
      });
      clientInjectWaitMs += Math.max(0, Date.now() - clientInjectAttemptStartedAt);
      if (injectResult.ok) {
        logPipelineStage('convert.client_inject.completed', injectOpts.requestId, {
          entryEndpoint: nestedEntry,
          handled: true,
          elapsedMs: Date.now() - clientInjectStartMs
        });
        return { ok: true };
      }
      logPipelineStage('convert.client_inject.completed', injectOpts.requestId, {
        entryEndpoint: nestedEntry,
        handled: false,
        reason: injectResult.reason || 'client_inject_not_handled',
        elapsedMs: Date.now() - clientInjectStartMs
      });
      return { ok: false, reason: injectResult.reason || 'client_inject_not_handled' };
    };

    logPipelineStage('convert.bridge.start', options.requestId, {
      entryEndpoint: options.entryEndpoint || entry,
      providerProtocol: options.providerProtocol,
      wantsStream: options.wantsStream
    });
    const bridgeStartMs = Date.now();
    const bridgeProviderResponse =
      extractBridgeProviderResponsePayload(body as Record<string, unknown>)
      ?? (body as Record<string, unknown>);
    const converted = await bridgeConvertProviderResponse({
      providerProtocol: options.providerProtocol,
      providerResponse: bridgeProviderResponse,
      context: adapterContext,
      entryEndpoint: options.entryEndpoint || entry,
      wantsStream: options.wantsStream,
      requestSemantics: options.requestSemantics,
      providerInvoker: serverToolsEnabled ? providerInvoker : undefined,
      stageRecorder,
      reenterPipeline: serverToolsEnabled ? reenterPipeline : undefined,
      clientInjectDispatch: serverToolsEnabled ? clientInjectDispatch : undefined
    });
    syncHubStageTopBackToPipelineMetadata({
      pipelineMetadata: options.pipelineMetadata,
      adapterContext
    });
    logPipelineStage('convert.bridge.completed', options.requestId, {
      entryEndpoint: options.entryEndpoint || entry,
      providerProtocol: options.providerProtocol,
      hasSse: Boolean(converted.__sse_responses),
      hasBody: converted.body !== undefined && converted.body !== null,
      elapsedMs: Date.now() - bridgeStartMs
    });
    validateConvertedProviderToolCallsOrThrow(converted.body ?? body, collectDeclaredToolNames(baseContext));
    if (converted.__sse_responses) {
      const usage = converted.body
        ? extractUsageFromResult({ body: converted.body })
        : undefined;
      const finishReason = deriveFinishReason(converted.body);
      logPipelineStage('convert.sse_wrapper_detected', options.requestId, {
        hasUsage: Boolean(usage),
        finishReason
      });
      return attachTimingBreakdown({
        ...options.response,
        body: buildServerToolSseWrapperBody({
          sseResponses: converted.__sse_responses,
          convertedBody: converted.body,
          usage
        })
      });
    }
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
        message
      });
      throw error;
    }
    const isSseDecodeError =
      errCode === 'SSE_DECODE_ERROR' ||
      errCode === 'HTTP_502' ||
      errCode === 'HTTP_429' ||
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

    const convertErrorPlan = finalizeServerToolBridgeConvertError({
      error,
      requestId: options.requestId,
      defaultFollowupStatus: 502,
      message,
      isSseDecodeError,
      isContextLengthExceeded,
      code: errCode,
      upstreamCode,
      detailUpstreamCode,
      detailReason
    });
    const isServerToolFollowupFailure = convertErrorPlan.handled
      && (errRecord as { requestExecutorProviderErrorStage?: unknown }).requestExecutorProviderErrorStage === 'provider.followup';
    const followupLogDetails = isServerToolFollowupFailure
      ? extractServerToolFollowupErrorLogDetails(error)
      : undefined;

    if (convertErrorPlan.handled) {
      if (isSseDecodeError || isContextLengthExceeded) {
        remapBridgeSseErrorToHttp(errRecord, message);
      }
      logPipelineStage('convert.bridge.error', options.requestId, {
        ...(isServerToolFollowupFailure
          ? (convertErrorPlan.stageDetails ?? {})
          : (convertErrorPlan.stageDetails ?? {
              code: followupLogDetails?.code || (typeof errRecord.code === 'string' ? errRecord.code : errCode),
              upstreamCode: followupLogDetails?.upstreamCode || upstreamCode || detailUpstreamCode,
              reason: followupLogDetails?.reason || compactFollowupLogReason(detailReason),
              message
            }))
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
      message
    });
    if (isVerboseErrorLoggingEnabled()) {
      console.error('[RequestExecutor] Failed to convert provider response via llmswitch-core', error);
    }
    throw error;
  }
}

