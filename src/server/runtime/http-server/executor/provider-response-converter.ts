import type { PipelineExecutionInput, PipelineExecutionResult } from '../../../handlers/types.js';
import type { ProviderHandle } from '../types.js';
import { asRecord } from '../provider-utils.js';
import {
  convertProviderResponse as bridgeConvertProviderResponse,
  createSnapshotRecorder as bridgeCreateSnapshotRecorder
} from '../../../../modules/llmswitch/bridge.js';
import { applyClientConnectionStateToContext } from '../../../utils/client-connection-state.js';
import { injectClockClientPrompt } from '../clock-client-registry.js';
import { bindClockConversationSession } from './request-retry-helpers.js';
import {
  extractClientModelId,
  normalizeProviderResponse
} from './provider-response-utils.js';
import { isVerboseErrorLoggingEnabled } from './env-config.js';
import { extractSseWrapperError } from './sse-error-handler.js';
import { isRateLimitLikeError } from './request-retry-helpers.js';

export type ConvertProviderResponseOptions = {
  entryEndpoint?: string;
  providerProtocol: string;
  providerType?: string;
  requestId: string;
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
      };
      error.code = 'SSE_DECODE_ERROR';
      if (wrapperError.errorCode) {
        error.upstreamCode = wrapperError.errorCode;
      }
      error.retryable = wrapperError.retryable;
      if (isRateLimitLikeError(wrapperError.message, wrapperError.errorCode)) {
        error.code = 'HTTP_429';
        error.status = 429;
        error.statusCode = 429;
        error.retryable = true;
      } else if (wrapperError.retryable) {
        error.status = 503;
        error.statusCode = 503;
      }
      throw error;
    }
  }
  if (options.processMode === 'passthrough' && !options.wantsStream) {
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
  try {
    const metadataBag = asRecord(options.pipelineMetadata);
    const originalModelId = extractClientModelId(metadataBag, options.originalRequest);
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
    if (
      baseContext.capturedChatRequest === undefined &&
      options.originalRequest &&
      typeof options.originalRequest === 'object' &&
      !Array.isArray(options.originalRequest)
    ) {
      baseContext.capturedChatRequest = options.originalRequest;
    }
    if (typeof (metadataBag as Record<string, unknown> | undefined)?.routeName === 'string') {
      baseContext.routeId = (metadataBag as Record<string, unknown>).routeName as string;
    }
    baseContext.requestId = options.requestId;
    baseContext.entryEndpoint = options.entryEndpoint || entry;
    baseContext.providerProtocol = options.providerProtocol;
    baseContext.originalModelId = originalModelId;
    if (assignedModelId && assignedModelId.trim()) {
      baseContext.modelId = assignedModelId.trim();
    }
    applyClientConnectionStateToContext(metadataBag, baseContext);
    const adapterContext = baseContext;
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
    const stageRecorder = await bridgeCreateSnapshotRecorder(
      adapterContext,
      typeof (adapterContext as Record<string, unknown>).entryEndpoint === 'string'
        ? ((adapterContext as Record<string, unknown>).entryEndpoint as string)
        : options.entryEndpoint || entry
    );

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
      const handle = deps.runtimeManager.getHandleByRuntimeKey(runtimeKey);
      if (!handle) {
        throw new Error(`Provider runtime ${runtimeKey} not found`);
      }
      const providerResponse = await handle.instance.processIncoming(invokeOptions.payload);
      const normalized = normalizeProviderResponse(providerResponse);
      const bodyPayload =
        normalized.body && typeof normalized.body === 'object'
          ? (normalized.body as Record<string, unknown>)
          : (normalized as unknown as Record<string, unknown>);
      return { providerResponse: bodyPayload };
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
      try {
        const baseRt = asRecord((metadataBag as any)?.__rt) ?? {};
        const extraRt = asRecord((nestedExtra as any)?.__rt) ?? {};
        if (Object.keys(baseRt).length || Object.keys(extraRt).length) {
          (nestedMetadata as any).__rt = { ...baseRt, ...extraRt };
        }
      } catch {
        // best-effort
      }

      if (asRecord((nestedMetadata as any).__rt)?.serverToolFollowup === true) {
        delete nestedMetadata.clientHeaders;
        delete nestedMetadata.clientRequestId;
      }

      bindClockConversationSession(nestedMetadata);

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
        const requestBody = reenterOpts.body as Record<string, unknown>;
        const messages = Array.isArray(requestBody.messages) ? (requestBody.messages as unknown[]) : [];
        const lastUser = [...messages]
          .reverse()
          .find((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).role === 'user') as
          | Record<string, unknown>
          | undefined;
        const text = typeof lastUser?.content === 'string' ? String(lastUser.content) : '';
        if (text.includes('<**clock:{') && text.includes('}**>')) {
          await injectClockClientPrompt({
            tmuxSessionId: typeof nestedMetadata.tmuxSessionId === 'string' ? nestedMetadata.tmuxSessionId : undefined,
            sessionId: typeof nestedMetadata.sessionId === 'string' ? nestedMetadata.sessionId : undefined,
            text,
            requestId: reenterOpts.requestId,
            source: 'servertool.reenter'
          });
        }
      } catch {
        // best-effort only
      }

      const nestedResult = await deps.executeNested(nestedInput);
      const nestedBody =
        nestedResult.body && typeof nestedResult.body === 'object'
          ? (nestedResult.body as Record<string, unknown>)
          : undefined;
      return { body: nestedBody };
    };

    const converted = await bridgeConvertProviderResponse({
      providerProtocol: options.providerProtocol,
      providerResponse: body as Record<string, unknown>,
      context: adapterContext,
      entryEndpoint: options.entryEndpoint || entry,
      wantsStream: options.wantsStream,
      requestSemantics: options.requestSemantics,
      providerInvoker,
      stageRecorder,
      reenterPipeline
    });
    if (converted.__sse_responses) {
      return {
        ...options.response,
        body: { __sse_responses: converted.__sse_responses }
      };
    }
    return {
      ...options.response,
      body: converted.body ?? body
    };
  } catch (error) {
    const err = error as Error | unknown;
    const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');
    const errRecord = err as Record<string, unknown>;
    const errCode = typeof errRecord.code === 'string' ? errRecord.code : undefined;
    const upstreamCode = typeof errRecord.upstreamCode === 'string' ? errRecord.upstreamCode : undefined;
    const errName = typeof errRecord.name === 'string' ? errRecord.name : undefined;
    const isSseDecodeError =
      errCode === 'SSE_DECODE_ERROR' ||
      (errName === 'ProviderProtocolError' && message.toLowerCase().includes('sse'));
    const isServerToolFollowupError =
      errCode === 'SERVERTOOL_FOLLOWUP_FAILED' ||
      errCode === 'SERVERTOOL_EMPTY_FOLLOWUP' ||
      (typeof errCode === 'string' && errCode.startsWith('SERVERTOOL_'));

    if (isSseDecodeError || isServerToolFollowupError) {
      if (isSseDecodeError && isRateLimitLikeError(message, errCode, upstreamCode)) {
        (errRecord as any).status = 429;
        (errRecord as any).statusCode = 429;
        (errRecord as any).retryable = true;
        if (typeof errRecord.code !== 'string' || !String(errRecord.code).trim()) {
          (errRecord as any).code = 'HTTP_429';
        }
      }
      if (isVerboseErrorLoggingEnabled()) {
        console.error(
          '[RequestExecutor] Fatal conversion error, bubbling as HTTP error',
          error
        );
      }
      throw error;
    }

    if (isVerboseErrorLoggingEnabled()) {
      console.error('[RequestExecutor] Failed to convert provider response via llmswitch-core', error);
    }
    return options.response;
  }
}
