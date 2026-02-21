import type { PipelineExecutionInput, PipelineExecutionResult } from '../../../handlers/types.js';
import type { ProviderHandle } from '../types.js';
import { asRecord } from '../provider-utils.js';
import {
  convertProviderResponse as bridgeConvertProviderResponse,
  createSnapshotRecorder as bridgeCreateSnapshotRecorder
} from '../../../../modules/llmswitch/bridge.js';
import { applyClientConnectionStateToContext } from '../../../utils/client-connection-state.js';
import {
  getClockClientRegistry,
  injectClockClientPromptWithResult
} from '../clock-client-registry.js';
import { bindClockConversationSession } from './request-retry-helpers.js';
import {
  extractClientModelId,
  normalizeProviderResponse
} from './provider-response-utils.js';
import { isVerboseErrorLoggingEnabled } from './env-config.js';
import { extractSseWrapperError } from './sse-error-handler.js';
import { isRateLimitLikeError } from './request-retry-helpers.js';

const FOLLOWUP_SESSION_HEADER_KEYS = new Set([
  'sessionid',
  'conversationid',
  'xsessionid',
  'xconversationid',
  'anthropicsessionid',
  'anthropicconversationid',
  'xroutecodexsessionid',
  'xroutecodexconversationid'
]);

function canonicalizeHeaderName(headerName: string): string {
  return headerName.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extractFollowupSessionHeaders(
  headers: unknown
): Record<string, string> | undefined {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return undefined;
  }
  const source = headers as Record<string, unknown>;
  const preserved: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(source)) {
    if (!FOLLOWUP_SESSION_HEADER_KEYS.has(canonicalizeHeaderName(headerName))) {
      continue;
    }
    if (typeof headerValue !== 'string') {
      continue;
    }
    const normalizedValue = headerValue.trim();
    if (!normalizedValue) {
      continue;
    }
    preserved[headerName] = normalizedValue;
  }
  return Object.keys(preserved).length ? preserved : undefined;
}

function extractPreservedSessionToken(
  headers: Record<string, string> | undefined,
  field: 'session' | 'conversation'
): string | undefined {
  if (!headers) {
    return undefined;
  }
  for (const [headerName, headerValue] of Object.entries(headers)) {
    const normalizedName = canonicalizeHeaderName(headerName);
    if (field === 'session' && normalizedName.endsWith('sessionid')) {
      return headerValue;
    }
    if (field === 'conversation' && normalizedName.endsWith('conversationid')) {
      return headerValue;
    }
  }
  return undefined;
}

function shouldUnbindConversationSessionOnInjectFailure(reasonRaw: unknown): boolean {
  const reason = typeof reasonRaw === 'string' ? reasonRaw.trim().toLowerCase() : '';
  return (
    reason === 'tmux_session_required' ||
    reason === 'no_matching_tmux_session_daemon' ||
    reason === 'workdir_mismatch' ||
    reason === 'inject_failed'
  );
}

function createClockInjectFailureError(args: {
  reason: string;
  source: string;
  requestId?: string;
  sessionId?: string;
  tmuxSessionId?: string;
}): Error & {
  code?: string;
  upstreamCode?: string;
  details?: Record<string, unknown>;
  status?: number;
  statusCode?: number;
  retryable?: boolean;
} {
  const error = new Error(
    `[servertool.inject] clock client injection failed: ${args.reason}`
  ) as Error & {
    code?: string;
    upstreamCode?: string;
    details?: Record<string, unknown>;
    status?: number;
    statusCode?: number;
    retryable?: boolean;
  };
  error.code = 'SERVERTOOL_FOLLOWUP_FAILED';
  error.upstreamCode = 'clock_client_inject_failed';
  error.details = {
    reason: args.reason,
    source: args.source,
    requestId: args.requestId,
    sessionId: args.sessionId,
    tmuxSessionId: args.tmuxSessionId
  };
  error.status = 503;
  error.statusCode = 503;
  error.retryable = false;
  return error;
}

function normalizeInjectToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function resolveInjectWorkdir(metadata: Record<string, unknown>): string | undefined {
  return (
    normalizeInjectToken(metadata.workdir) ||
    normalizeInjectToken(metadata.cwd) ||
    normalizeInjectToken(metadata.workingDirectory)
  );
}

function resolveInjectConversationSessionId(metadata: Record<string, unknown>): string | undefined {
  const daemonId =
    normalizeInjectToken(metadata.clockDaemonId) ||
    normalizeInjectToken(metadata.clockClientDaemonId);
  if (daemonId) {
    return `clockd.${daemonId}`;
  }
  return (
    normalizeInjectToken(metadata.sessionId) ||
    normalizeInjectToken(metadata.session_id) ||
    normalizeInjectToken(metadata.conversationId) ||
    normalizeInjectToken(metadata.conversation_id)
  );
}

function resolveStopMessageClientInjectReadiness(metadata: Record<string, unknown>): {
  ready: boolean;
  reason: string;
  sessionScope?: string;
  tmuxSessionId?: string;
} {
  const registry = getClockClientRegistry();
  const explicitClientInjectReadyRaw = metadata.clientInjectReady ?? metadata.client_inject_ready;
  const explicitClientInjectReady =
    explicitClientInjectReadyRaw === true
      ? true
      : explicitClientInjectReadyRaw === false
        ? false
        : (typeof explicitClientInjectReadyRaw === 'string'
          ? (explicitClientInjectReadyRaw.trim().toLowerCase() === 'true'
            ? true
            : (explicitClientInjectReadyRaw.trim().toLowerCase() === 'false' ? false : undefined))
          : undefined);
  if (explicitClientInjectReady === false) {
    const explicitReason =
      typeof metadata.clientInjectReason === 'string'
        ? metadata.clientInjectReason.trim()
        : (typeof metadata.client_inject_reason === 'string' ? metadata.client_inject_reason.trim() : '');
    return { ready: false, reason: explicitReason || 'client_inject_unready' };
  }
  const tmuxSessionId = normalizeInjectToken(metadata.tmuxSessionId);
  const sessionScope = resolveInjectConversationSessionId(metadata);
  const daemonId =
    normalizeInjectToken(metadata.clockDaemonId) ||
    normalizeInjectToken(metadata.clockClientDaemonId);
  const workdir = resolveInjectWorkdir(metadata);
  const clientType = normalizeInjectToken(metadata.clockClientType) || normalizeInjectToken(metadata.clientType);
  if (tmuxSessionId) {
    return { ready: true, reason: 'tmux_direct', tmuxSessionId, ...(sessionScope ? { sessionScope } : {}) };
  }
  if (!sessionScope) {
    return { ready: false, reason: 'tmux_scope_binding_required' };
  }

  const mappedTmuxSessionId = normalizeInjectToken(registry.resolveBoundTmuxSession(sessionScope));
  if (mappedTmuxSessionId) {
    return { ready: true, reason: 'tmux_bound', sessionScope, tmuxSessionId: mappedTmuxSessionId };
  }

  const bind = registry.bindConversationSession({
    conversationSessionId: sessionScope,
    ...(daemonId ? { daemonId } : {}),
    ...(workdir ? { workdir } : {}),
    ...(clientType ? { clientType } : {})
  });
  if (bind.ok && normalizeInjectToken(bind.tmuxSessionId)) {
    return {
      ready: true,
      reason: 'tmux_bound_on_demand',
      sessionScope,
      tmuxSessionId: normalizeInjectToken(bind.tmuxSessionId)
    };
  }
  return {
    ready: false,
    reason: normalizeInjectToken(bind.reason) || 'conversation_session_unbound',
    sessionScope
  };
}

function resolveStrictClientInjectTarget(args: {
  tmuxSessionId?: unknown;
  clockDaemonId?: unknown;
  conversationSessionId?: unknown;
  clientInjectReady?: unknown;
  clientInjectReason?: unknown;
  requestId?: string;
  source: string;
}): { tmuxSessionId?: string; sessionId?: string } {
  const registry = getClockClientRegistry();
  const tmuxSessionId = normalizeInjectToken(args.tmuxSessionId);
  const daemonId = normalizeInjectToken(args.clockDaemonId);
  const conversationScopeSessionId = normalizeInjectToken(args.conversationSessionId);
  const explicitClientInjectReadyRaw = args.clientInjectReady;
  const explicitClientInjectReady =
    explicitClientInjectReadyRaw === true
      ? true
      : explicitClientInjectReadyRaw === false
        ? false
        : (typeof explicitClientInjectReadyRaw === 'string'
          ? (explicitClientInjectReadyRaw.trim().toLowerCase() === 'true'
            ? true
            : (explicitClientInjectReadyRaw.trim().toLowerCase() === 'false' ? false : undefined))
          : undefined);
  if (explicitClientInjectReady === false) {
    throw createClockInjectFailureError({
      reason: normalizeInjectToken(args.clientInjectReason) || 'client_inject_unready',
      source: args.source,
      requestId: args.requestId
    });
  }
  const daemonScopeSessionId = daemonId ? `clockd.${daemonId}` : undefined;
  if (!tmuxSessionId && !daemonScopeSessionId && !conversationScopeSessionId) {
    throw createClockInjectFailureError({
      reason: 'tmux_scope_binding_required',
      source: args.source,
      requestId: args.requestId
    });
  }
  if (tmuxSessionId) {
    return { tmuxSessionId };
  }
  const targetSessionId = daemonScopeSessionId || conversationScopeSessionId;
  const daemonRecord = daemonId ? registry.findByDaemonId(daemonId) : undefined;
  const sessionScopedTmuxSessionId =
    normalizeInjectToken(targetSessionId ? registry.resolveBoundTmuxSession(targetSessionId) : undefined);
  const boundTmuxSessionId =
    normalizeInjectToken(daemonRecord?.tmuxSessionId) ||
    normalizeInjectToken(daemonRecord?.sessionId) ||
    sessionScopedTmuxSessionId;

  if (!boundTmuxSessionId) {
    if (targetSessionId) {
      try {
        registry.unbindConversationSession(targetSessionId);
      } catch {
        // best-effort cleanup
      }
    }
    throw createClockInjectFailureError({
      reason: 'conversation_session_unbound',
      source: args.source,
      requestId: args.requestId,
      sessionId: targetSessionId
    });
  }

  return {
    sessionId: targetSessionId,
    tmuxSessionId: boundTmuxSessionId
  };
}

async function injectClockClientPromptStrict(args: {
  tmuxSessionId?: string;
  sessionId?: string;
  workdir?: string;
  requestId?: string;
  text: string;
  source: string;
}): Promise<void> {
  const result = await injectClockClientPromptWithResult({
    tmuxSessionId: args.tmuxSessionId,
    sessionId: args.sessionId,
    workdir: args.workdir,
    requestId: args.requestId,
    text: args.text,
    source: args.source
  });
  if (result.ok) {
    return;
  }

  const reason = typeof result.reason === 'string' ? result.reason : 'inject_failed';
  const normalizedSessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  if (normalizedSessionId && shouldUnbindConversationSessionOnInjectFailure(reason)) {
    try {
      getClockClientRegistry().unbindConversationSession(normalizedSessionId);
    } catch {
      // best-effort cleanup only
    }
  }

  throw createClockInjectFailureError({
    reason,
    source: args.source,
    requestId: args.requestId,
    sessionId: args.sessionId,
    tmuxSessionId: args.tmuxSessionId
  });
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
    const serverToolsEnabled = options.serverToolsEnabled !== false;
    (adapterContext as Record<string, unknown>).serverToolsEnabled = serverToolsEnabled;
    if (!serverToolsEnabled) {
      (adapterContext as Record<string, unknown>).serverToolsDisabled = true;
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
        const preservedClientHeaders = extractFollowupSessionHeaders(nestedMetadata.clientHeaders);
        if (preservedClientHeaders) {
          nestedMetadata.clientHeaders = preservedClientHeaders;
          if (typeof nestedMetadata.sessionId !== 'string' || !nestedMetadata.sessionId.trim()) {
            const sessionId = extractPreservedSessionToken(preservedClientHeaders, 'session');
            if (sessionId) {
              nestedMetadata.sessionId = sessionId;
            }
          }
          if (typeof nestedMetadata.conversationId !== 'string' || !nestedMetadata.conversationId.trim()) {
            const conversationId = extractPreservedSessionToken(preservedClientHeaders, 'conversation');
            if (conversationId) {
              nestedMetadata.conversationId = conversationId;
            }
          }
        } else {
          delete nestedMetadata.clientHeaders;
        }
        delete nestedMetadata.clientRequestId;
      }

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
        const clientInjectOnlyRaw = nestedMetadata.clientInjectOnly;
        const clientInjectOnly =
          clientInjectOnlyRaw === true ||
          (typeof clientInjectOnlyRaw === 'string' && clientInjectOnlyRaw.trim().toLowerCase() === 'true');
        const clientInjectText =
          typeof nestedMetadata.clientInjectText === 'string' ? nestedMetadata.clientInjectText.trim() : '';
        const clientInjectSource =
          typeof nestedMetadata.clientInjectSource === 'string' && nestedMetadata.clientInjectSource.trim()
            ? nestedMetadata.clientInjectSource.trim()
            : 'servertool.client_inject';
        const requestBody =
          reenterOpts.body && typeof reenterOpts.body === 'object' && !Array.isArray(reenterOpts.body)
            ? (reenterOpts.body as Record<string, unknown>)
            : {};
        const messages = Array.isArray(requestBody.messages) ? (requestBody.messages as unknown[]) : [];
        const lastUser = [...messages]
          .reverse()
          .find((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).role === 'user') as
          | Record<string, unknown>
          | undefined;
        const text = typeof lastUser?.content === 'string' ? String(lastUser.content) : '';
        const injectTarget = {
          tmuxSessionId: typeof nestedMetadata.tmuxSessionId === 'string' ? nestedMetadata.tmuxSessionId : undefined,
          sessionId: typeof nestedMetadata.sessionId === 'string' ? nestedMetadata.sessionId : undefined,
          workdir: typeof nestedMetadata.workdir === 'string' ? nestedMetadata.workdir : undefined,
          requestId: reenterOpts.requestId
        };
        if (clientInjectOnly) {
          bindClockConversationSession(nestedMetadata);
          const strictTarget = resolveStrictClientInjectTarget({
            tmuxSessionId: injectTarget.tmuxSessionId,
            clockDaemonId:
              typeof nestedMetadata.clockDaemonId === 'string'
                ? nestedMetadata.clockDaemonId
                : (typeof nestedMetadata.clockClientDaemonId === 'string' ? nestedMetadata.clockClientDaemonId : undefined),
            conversationSessionId:
              typeof nestedMetadata.sessionId === 'string'
                ? nestedMetadata.sessionId
                : typeof nestedMetadata.session_id === 'string'
                  ? nestedMetadata.session_id
                  : typeof nestedMetadata.conversationId === 'string'
                    ? nestedMetadata.conversationId
                    : (typeof nestedMetadata.conversation_id === 'string' ? nestedMetadata.conversation_id : undefined),
            clientInjectReady:
              nestedMetadata.clientInjectReady ?? nestedMetadata.client_inject_ready,
            clientInjectReason:
              nestedMetadata.clientInjectReason ?? nestedMetadata.client_inject_reason,
            requestId: reenterOpts.requestId,
            source: clientInjectSource
          });
          const injectText = clientInjectText || text || '继续执行';
          await injectClockClientPromptStrict({
            tmuxSessionId: strictTarget.tmuxSessionId,
            sessionId: strictTarget.sessionId,
            workdir: injectTarget.workdir,
            requestId: injectTarget.requestId,
            text: injectText,
            source: clientInjectSource
          });
          return { body: { ok: true, mode: 'client_inject_only' } };
        }
        bindClockConversationSession(nestedMetadata);
        const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined;
        const lastTool =
          lastMessage && typeof lastMessage === 'object' && !Array.isArray(lastMessage)
            ? (lastMessage as Record<string, unknown>)
            : undefined;
        const lastToolRole = typeof lastTool?.role === 'string' ? lastTool.role : '';
        const lastToolName = typeof lastTool?.name === 'string' ? String(lastTool.name).trim() : '';
        if (text.includes('<**clock:{') && text.includes('}**>')) {
          await injectClockClientPromptStrict({
            ...injectTarget,
            text,
            source: 'servertool.reenter'
          });
        }
        if (lastToolRole === 'tool' && lastToolName === 'continue_execution') {
          await injectClockClientPromptStrict({
            ...injectTarget,
            text: '继续执行',
            source: 'servertool.continue_execution'
          });
        }
      } catch (error) {
        const code = typeof (error as { code?: unknown })?.code === 'string'
          ? String((error as { code?: string }).code)
          : '';
        if (code === 'SERVERTOOL_FOLLOWUP_FAILED') {
          throw error;
        }
        // best-effort only for non-critical inject attempts
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
      providerInvoker: serverToolsEnabled ? providerInvoker : undefined,
      stageRecorder,
      reenterPipeline: serverToolsEnabled ? reenterPipeline : undefined
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
    const detailRecord = asRecord(errRecord.details);
    const detailUpstreamCode =
      typeof (detailRecord as Record<string, unknown> | undefined)?.upstreamCode === 'string'
        ? String((detailRecord as Record<string, unknown>).upstreamCode)
        : undefined;
    const detailReason =
      typeof (detailRecord as Record<string, unknown> | undefined)?.reason === 'string'
        ? String((detailRecord as Record<string, unknown>).reason)
        : undefined;
    const isSseDecodeError =
      errCode === 'SSE_DECODE_ERROR' ||
      (errName === 'ProviderProtocolError' && message.toLowerCase().includes('sse'));
    const isServerToolFollowupError =
      errCode === 'SERVERTOOL_FOLLOWUP_FAILED' ||
      errCode === 'SERVERTOOL_EMPTY_FOLLOWUP' ||
      (typeof errCode === 'string' && errCode.startsWith('SERVERTOOL_'));
    const normalizedUpstreamCode = (upstreamCode || detailUpstreamCode || '').trim().toLowerCase();
    const normalizedMessage = message.toLowerCase();
    const isContextLengthExceeded =
      normalizedUpstreamCode.includes('context_length_exceeded') ||
      normalizedMessage.includes('context_length_exceeded') ||
      normalizedMessage.includes('达到对话长度上限') ||
      normalizedMessage.includes('对话长度上限') ||
      (detailReason || '').toLowerCase() === 'context_length_exceeded';

    if (isSseDecodeError || isServerToolFollowupError) {
      if (isSseDecodeError && isContextLengthExceeded) {
        (errRecord as any).status = 400;
        (errRecord as any).statusCode = 400;
        (errRecord as any).retryable = false;
        (errRecord as any).code = 'CONTEXT_LENGTH_EXCEEDED';
        if (typeof errRecord.upstreamCode !== 'string' || !String(errRecord.upstreamCode).trim()) {
          (errRecord as any).upstreamCode = upstreamCode || detailUpstreamCode || 'context_length_exceeded';
        }
      } else if (isSseDecodeError && isRateLimitLikeError(message, errCode, upstreamCode || detailUpstreamCode)) {
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
