import type { PipelineExecutionInput, PipelineExecutionResult } from '../../handlers/types.js';
import { mapProviderProtocol, asRecord } from './provider-utils.js';
import { extractAnthropicToolAliasMap } from './anthropic-tool-alias.js';
import {
  convertProviderResponse as bridgeConvertProviderResponse,
  createSnapshotRecorder as bridgeCreateSnapshotRecorder,
  syncReasoningStopModeFromRequest
} from '../../../modules/llmswitch/bridge.js';
import { applyClientConnectionStateToContext } from '../../utils/client-connection-state.js';
import {
  resolveStopMessageClientInjectReadiness,
  runClientInjectionFlowBeforeReenter
} from './executor/client-injection-flow.js';
import { deriveFinishReason, STREAM_LOG_FINISH_REASON_KEY } from '../../utils/finish-reason.js';

export interface ConvertProviderResponseOptions {
  entryEndpoint?: string;
  providerType?: string;
  requestId: string;
  wantsStream: boolean;
  originalRequest?: Record<string, unknown> | undefined;
  processMode?: string;
  serverToolsEnabled?: boolean;
  response: PipelineExecutionResult;
  pipelineMetadata?: Record<string, unknown>;
}

export interface ConvertProviderResponseDeps {
  logStage(stage: string, requestId: string, details?: Record<string, unknown>): void;
  executeNested(input: PipelineExecutionInput): Promise<PipelineExecutionResult>;
}

const FOLLOWUP_LOG_REASON_MAX_LEN = 180;

function readSessionLikeToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asFlatRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function backfillAdapterContextSessionIdentifiersFromOriginalRequest(
  baseContext: Record<string, unknown>,
  originalRequest: unknown
): void {
  const original = asFlatRecord(originalRequest);
  if (!original) {
    return;
  }
  const requestMetadata = asFlatRecord(original.metadata);
  const capturedRequest = asFlatRecord(baseContext.capturedChatRequest);
  const capturedMetadata = asFlatRecord(capturedRequest?.metadata);

  const sessionId =
    readSessionLikeToken(baseContext.sessionId) ??
    readSessionLikeToken(original.sessionId) ??
    readSessionLikeToken(original.session_id) ??
    readSessionLikeToken(requestMetadata?.sessionId) ??
    readSessionLikeToken(requestMetadata?.session_id) ??
    readSessionLikeToken(capturedRequest?.sessionId) ??
    readSessionLikeToken(capturedRequest?.session_id) ??
    readSessionLikeToken(capturedMetadata?.sessionId) ??
    readSessionLikeToken(capturedMetadata?.session_id);
  const conversationId =
    readSessionLikeToken(baseContext.conversationId) ??
    readSessionLikeToken(original.conversationId) ??
    readSessionLikeToken(original.conversation_id) ??
    readSessionLikeToken(requestMetadata?.conversationId) ??
    readSessionLikeToken(requestMetadata?.conversation_id) ??
    readSessionLikeToken(capturedRequest?.conversationId) ??
    readSessionLikeToken(capturedRequest?.conversation_id) ??
    readSessionLikeToken(capturedMetadata?.conversationId) ??
    readSessionLikeToken(capturedMetadata?.conversation_id);

  if (sessionId && !readSessionLikeToken(baseContext.sessionId)) {
    baseContext.sessionId = sessionId;
  }
  if (conversationId && !readSessionLikeToken(baseContext.conversationId)) {
    baseContext.conversationId = conversationId;
  }
}

function seedReasoningStopStateFromCapturedRequest(
  baseContext: Record<string, unknown>
): void {
  try {
    syncReasoningStopModeFromRequest(baseContext, 'on');
  } catch {
    // best-effort
  }
}

function compactFollowupLogReason(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return undefined;
  }
  const httpMatch =
    normalized.match(/^http\s+(\d{3})\s*:/i) ||
    normalized.match(/\bhttp\s+(\d{3})\b/i);
  if (httpMatch?.[1]) {
    return `HTTP_${httpMatch[1]}`;
  }
  if (/<\s*!doctype\s+html\b/i.test(normalized) || /<\s*html\b/i.test(normalized)) {
    return 'UPSTREAM_HTML_ERROR';
  }
  if (normalized.length <= FOLLOWUP_LOG_REASON_MAX_LEN) {
    return normalized;
  }
  return `${normalized.slice(0, FOLLOWUP_LOG_REASON_MAX_LEN)}…`;
}

function extractClientModelId(
  metadata: Record<string, unknown>,
  originalRequest?: Record<string, unknown>
): string | undefined {
  const candidates = [
    metadata.clientModelId,
    metadata.originalModelId,
    (metadata.target && typeof metadata.target === 'object'
      ? (metadata.target as Record<string, unknown>).clientModelId
      : undefined),
    originalRequest && typeof originalRequest === 'object'
      ? (originalRequest as Record<string, unknown>).model
      : undefined,
    originalRequest && typeof originalRequest === 'object'
      ? (originalRequest as Record<string, unknown>).originalModelId
      : undefined
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

export async function convertProviderResponseIfNeeded(
  options: ConvertProviderResponseOptions,
  deps: ConvertProviderResponseDeps
): Promise<PipelineExecutionResult> {
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
  const body = options.response.body;
  if (!body || typeof body !== 'object') {
    return options.response;
  }

  try {
    const providerProtocol = mapProviderProtocol(options.providerType);
    const metadataBag = asRecord(options.pipelineMetadata);
    const aliasMap = extractAnthropicToolAliasMap(metadataBag);
    const originalModelId = extractClientModelId(metadataBag ?? {}, options.originalRequest);
    const assignedModelId =
      typeof (metadataBag as Record<string, unknown> | undefined)?.assignedModelId === 'string'
        ? String((metadataBag as Record<string, unknown>).assignedModelId)
        : metadataBag &&
            typeof metadataBag === 'object' &&
            metadataBag.target &&
            typeof metadataBag.target === 'object' &&
            typeof (metadataBag.target as Record<string, unknown>).modelId === 'string'
          ? ((metadataBag.target as Record<string, unknown>).modelId as string)
          : typeof (metadataBag as Record<string, unknown> | undefined)?.modelId === 'string'
            ? String((metadataBag as Record<string, unknown>).modelId)
            : undefined;
    const baseContext: Record<string, unknown> = {
      ...(metadataBag ?? {})
    };
    const hasValidCapturedChatRequest =
      baseContext.capturedChatRequest &&
      typeof baseContext.capturedChatRequest === 'object' &&
      !Array.isArray(baseContext.capturedChatRequest);
    if (
      !hasValidCapturedChatRequest &&
      options.originalRequest &&
      typeof options.originalRequest === 'object' &&
      !Array.isArray(options.originalRequest)
    ) {
      baseContext.capturedChatRequest = options.originalRequest;
    }
    backfillAdapterContextSessionIdentifiersFromOriginalRequest(baseContext, options.originalRequest);
    seedReasoningStopStateFromCapturedRequest(baseContext);
    if (typeof (metadataBag as Record<string, unknown> | undefined)?.routeName === 'string') {
      baseContext.routeId = (metadataBag as Record<string, unknown>).routeName as string;
    }
    baseContext.requestId = options.requestId;
    baseContext.entryEndpoint = options.entryEndpoint || entry;
    baseContext.providerProtocol = providerProtocol;
    baseContext.originalModelId = originalModelId;
    if (assignedModelId && assignedModelId.trim()) {
      baseContext.modelId = assignedModelId.trim();
    }
    applyClientConnectionStateToContext(metadataBag, baseContext);
    const adapterContext = baseContext;
    const stopMessageInjectReadiness = resolveStopMessageClientInjectReadiness(baseContext);
    {
      const rt = asRecord((adapterContext as Record<string, unknown>).__rt) ?? {};
      (adapterContext as Record<string, unknown>).__rt = {
        ...rt,
        stopMessageClientInjectReady: stopMessageInjectReadiness.ready,
        stopMessageClientInjectReason: stopMessageInjectReadiness.reason,
        ...(stopMessageInjectReadiness.sessionScope
          ? { stopMessageClientInjectSessionScope: stopMessageInjectReadiness.sessionScope }
          : {}),
        ...(stopMessageInjectReadiness.tmuxSessionId
          ? { stopMessageClientInjectTmuxSessionId: stopMessageInjectReadiness.tmuxSessionId }
          : {})
      };
    }
    const hasTargetMetadata =
      metadataBag &&
      typeof metadataBag === 'object' &&
      metadataBag.target &&
      typeof metadataBag.target === 'object';
    const targetCompatProfile =
      hasTargetMetadata &&
      typeof (metadataBag.target as Record<string, unknown>).compatibilityProfile === 'string'
        ? ((metadataBag.target as Record<string, unknown>).compatibilityProfile as string)
        : undefined;
    const metadataCompatProfile =
      typeof (metadataBag as Record<string, unknown> | undefined)?.compatibilityProfile === 'string'
        ? String((metadataBag as Record<string, unknown>).compatibilityProfile)
        : undefined;
    const compatProfile = hasTargetMetadata ? targetCompatProfile : metadataCompatProfile;
    if (compatProfile && compatProfile.trim()) {
      adapterContext.compatibilityProfile = compatProfile.trim();
    }
    if (aliasMap) {
      (adapterContext as Record<string, unknown>).anthropicToolNameMap = aliasMap;
    }

    const stageRecorder = await bridgeCreateSnapshotRecorder(
      adapterContext,
      typeof (adapterContext as Record<string, unknown>).entryEndpoint === 'string'
        ? ((adapterContext as Record<string, unknown>).entryEndpoint as string)
        : entry
    );

    const providerInvoker = async (invokeOptions: {
      providerKey: string;
      payload: Record<string, unknown>;
      routeHint?: string;
    }): Promise<{ providerResponse: Record<string, unknown> }> => {
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

      const nestedInput: PipelineExecutionInput = {
        entryEndpoint: options.entryEndpoint || entry,
        method: 'POST',
        requestId: options.requestId,
        headers: {},
        query: {},
        body: invokeOptions.payload,
        metadata: {
          ...(metadataBag ?? {}),
          direction: 'request',
          stage: 'provider.invoke'
        }
      };
      const nestedResult = await deps.executeNested(nestedInput);
      const nestedBody =
        nestedResult.body && typeof nestedResult.body === 'object'
          ? (nestedResult.body as Record<string, unknown>)
          : (nestedResult as unknown as Record<string, unknown>);
      return { providerResponse: nestedBody };
    };

    const reenterPipeline = async (reenterOpts: {
      entryEndpoint: string;
      requestId: string;
      body: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    }): Promise<{ body?: Record<string, unknown>; __sse_responses?: unknown; format?: string }> => {
      const nestedEntry = reenterOpts.entryEndpoint || options.entryEndpoint || entry;
      const nestedExtra = asRecord(reenterOpts.metadata) ?? {};

      const nestedMetadata: Record<string, unknown> = {
        ...(metadataBag ?? {}),
        ...nestedExtra,
        entryEndpoint: nestedEntry,
        direction: 'request',
        stage: 'inbound'
      };

      const nestedInput: PipelineExecutionInput = {
        entryEndpoint: nestedEntry,
        method: 'POST',
        requestId: reenterOpts.requestId,
        headers: {},
        query: {},
        body: reenterOpts.body,
        metadata: nestedMetadata
      };

      try {
        const requestBody =
          reenterOpts.body && typeof reenterOpts.body === 'object' && !Array.isArray(reenterOpts.body)
            ? (reenterOpts.body as Record<string, unknown>)
            : {};
        const injectResult = await runClientInjectionFlowBeforeReenter({
          nestedMetadata,
          requestBody,
          requestId: reenterOpts.requestId
        });
        if (injectResult.clientInjectOnlyHandled) {
          return { body: { ok: true, mode: 'client_inject_only' } };
        }
      } catch (error) {
        throw error;
      }

      const nestedResult = await deps.executeNested(nestedInput);
      const nestedBody =
        nestedResult.body && typeof nestedResult.body === 'object'
          ? (nestedResult.body as Record<string, unknown>)
          : undefined;
      return { body: nestedBody };
    };

    const converted = await bridgeConvertProviderResponse({
      providerProtocol,
      providerResponse: body as Record<string, unknown>,
      context: adapterContext,
      entryEndpoint: options.entryEndpoint || entry,
      wantsStream: options.wantsStream,
      providerInvoker,
      stageRecorder,
      reenterPipeline
    });

    if (converted.__sse_responses) {
      const finishReason = deriveFinishReason(converted.body);
      const wrapperBody: Record<string, unknown> = { __sse_responses: converted.__sse_responses };
      if (finishReason) {
        wrapperBody[STREAM_LOG_FINISH_REASON_KEY] = finishReason;
      }
      return {
        ...options.response,
        body: wrapperBody
      };
    }

    return {
      ...options.response,
      body: converted.body ?? body
    };
  } catch (error) {
    const err = error as Error | unknown;
    const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');
    const providerProtocol = mapProviderProtocol(options.providerType);
    const errRecord = err as Record<string, unknown>;
    const errCode = typeof errRecord.code === 'string' ? errRecord.code : undefined;
    const upstreamCode = typeof errRecord.upstreamCode === 'string' ? errRecord.upstreamCode : undefined;
    const detailRecord = asRecord(errRecord.details);
    const detailReason =
      typeof (detailRecord as Record<string, unknown> | undefined)?.reason === 'string'
        ? String((detailRecord as Record<string, unknown>).reason)
        : typeof (detailRecord as Record<string, unknown> | undefined)?.error === 'string'
          ? String((detailRecord as Record<string, unknown>).error)
        : undefined;
    const detailUpstreamCode =
      typeof (detailRecord as Record<string, unknown> | undefined)?.upstreamCode === 'string'
        ? String((detailRecord as Record<string, unknown>).upstreamCode)
        : undefined;

    const isSseConvertFailure =
      typeof message === 'string' &&
      message.toLowerCase().includes('failed to convert sse payload');
    const isServerToolFollowupError =
      errCode === 'SERVERTOOL_FOLLOWUP_FAILED' ||
      errCode === 'SERVERTOOL_EMPTY_FOLLOWUP' ||
      (typeof errCode === 'string' && errCode.startsWith('SERVERTOOL_'));

    if (isServerToolFollowupError) {
      const compactReason = compactFollowupLogReason(detailReason) || compactFollowupLogReason(message);
      const compactUpstreamCode = compactFollowupLogReason(upstreamCode || detailUpstreamCode);
      const compactCode = compactFollowupLogReason(errCode) || errCode || 'UNKNOWN';
      console.warn(
        `[RequestExecutor] ServerTool followup failed req=${options.requestId}` +
          ` code=${compactCode}` +
          (compactUpstreamCode ? ` upstreamCode=${compactUpstreamCode}` : '') +
          (compactReason ? ` reason=${JSON.stringify(compactReason)}` : '')
      );
      throw error;
    }

    if (providerProtocol === 'gemini-chat' && isSseConvertFailure) {
      console.error(
        '[RequestExecutor] Fatal SSE decode error for Gemini provider, bubbling as HTTP error',
        error
      );
      throw error;
    }

    console.error('[RequestExecutor] Failed to convert provider response via llmswitch-core', error);
    throw error;
  }
}
