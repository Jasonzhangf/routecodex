import {
  getClockClientRegistry,
  injectClockClientPromptWithResult
} from '../clock-client-registry.js';
import { bindClockConversationSession } from './request-retry-helpers.js';

export type StopMessageClientInjectReadiness = {
  ready: boolean;
  reason: string;
  sessionScope?: string;
  tmuxSessionId?: string;
};

type StrictClientInjectTarget = {
  tmuxSessionId: string;
  sessionScope?: string;
};

type ClientInjectionTarget = {
  tmuxSessionId?: string;
  tmuxTarget?: string;
  clientType?: string;
  workdir?: string;
  requestId?: string;
};

function shouldUnbindConversationSessionOnInjectFailure(reasonRaw: unknown): boolean {
  const reason = typeof reasonRaw === 'string' ? reasonRaw.trim().toLowerCase() : '';
  return (
    reason === 'tmux_session_required' ||
    reason === 'no_matching_tmux_session_daemon' ||
    reason === 'workdir_mismatch' ||
    reason === 'inject_failed'
  );
}

function createClientInjectFailureError(args: {
  reason: string;
  source: string;
  requestId?: string;
  sessionId?: string;
  tmuxSessionId?: string;
  code?: string;
  upstreamCode?: string;
  status?: number;
}): Error & {
  code?: string;
  upstreamCode?: string;
  details?: Record<string, unknown>;
  status?: number;
  statusCode?: number;
  retryable?: boolean;
} {
  const error = new Error(
    `[servertool.inject] client injection failed: ${args.reason}`
  ) as Error & {
    code?: string;
    upstreamCode?: string;
    details?: Record<string, unknown>;
    status?: number;
    statusCode?: number;
    retryable?: boolean;
  };
  error.code = args.code || 'SERVERTOOL_FOLLOWUP_FAILED';
  error.upstreamCode = args.upstreamCode || 'client_inject_failed';
  error.details = {
    reason: args.reason,
    source: args.source,
    requestId: args.requestId,
    sessionId: args.sessionId,
    tmuxSessionId: args.tmuxSessionId
  };
  const status = Number.isFinite(args.status) ? Math.floor(Number(args.status)) : 503;
  error.status = status;
  error.statusCode = status;
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

function shouldTreatExplicitUnreadyAsHardBlock(reasonRaw: unknown): boolean {
  void reasonRaw;
  return true;
}

function resolveInjectWorkdir(metadata: Record<string, unknown>): string | undefined {
  return (
    normalizeInjectToken(metadata.clientWorkdir) ||
    normalizeInjectToken(metadata.client_workdir) ||
    normalizeInjectToken(metadata.workdir) ||
    normalizeInjectToken(metadata.cwd) ||
    normalizeInjectToken(metadata.workingDirectory)
  );
}

function resolveInjectConversationSessionId(metadata: Record<string, unknown>): string | undefined {
  const tmuxSessionId =
    normalizeInjectToken(metadata.clientTmuxSessionId) ||
    normalizeInjectToken(metadata.client_tmux_session_id) ||
    normalizeInjectToken(metadata.tmuxSessionId);
  if (tmuxSessionId) {
    return `tmux:${tmuxSessionId}`;
  }
  return undefined;
}

function resolveStrictClientInjectTarget(args: {
  tmuxSessionId?: unknown;
  conversationSessionId?: unknown;
  clientInjectReady?: unknown;
  clientInjectReason?: unknown;
  requestId?: string;
  source: string;
  failureCode?: string;
  failureUpstreamCode?: string;
  failureStatus?: number;
}): StrictClientInjectTarget {
  const tmuxSessionId = normalizeInjectToken(args.tmuxSessionId);
  const rawConversationScopeSessionId = normalizeInjectToken(args.conversationSessionId);
  const conversationScopeSessionId =
    rawConversationScopeSessionId && rawConversationScopeSessionId.startsWith('tmux:')
      ? rawConversationScopeSessionId
      : undefined;
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
  const explicitClientInjectReason = normalizeInjectToken(args.clientInjectReason);
  if (explicitClientInjectReady === false && shouldTreatExplicitUnreadyAsHardBlock(explicitClientInjectReason)) {
    throw createClientInjectFailureError({
      reason: explicitClientInjectReason || 'client_inject_unready',
      source: args.source,
      requestId: args.requestId,
      code: args.failureCode,
      upstreamCode: args.failureUpstreamCode,
      status: args.failureStatus
    });
  }

  const tmuxScopeSessionId = tmuxSessionId ? `tmux:${tmuxSessionId}` : undefined;
  const targetSessionId = conversationScopeSessionId || tmuxScopeSessionId;
  if (!tmuxSessionId) {
    throw createClientInjectFailureError({
      reason: 'tmux_session_required',
      source: args.source,
      requestId: args.requestId,
      code: args.failureCode,
      upstreamCode: args.failureUpstreamCode,
      status: args.failureStatus
    });
  }

  return {
    tmuxSessionId,
    ...(targetSessionId ? { sessionScope: targetSessionId } : {})
  };
}

async function injectClientPromptStrict(args: {
  tmuxSessionId?: string;
  sessionScope?: string;
  tmuxTarget?: string;
  clientType?: string;
  workdir?: string;
  requestId?: string;
  text: string;
  source: string;
  failureCode?: string;
  failureUpstreamCode?: string;
  failureStatus?: number;
}): Promise<void> {
  const result = await injectClockClientPromptWithResult({
    tmuxSessionId: args.tmuxSessionId,
    ...(args.tmuxTarget ? { tmuxTarget: args.tmuxTarget } : {}),
    ...(args.clientType ? { clientType: args.clientType } : {}),
    tmuxOnly: true,
    workdir: args.workdir,
    requestId: args.requestId,
    text: args.text,
    source: args.source
  });
  if (result.ok) {
    return;
  }

  const reason = typeof result.reason === 'string' ? result.reason : 'inject_failed';
  const normalizedSessionScope = typeof args.sessionScope === 'string' ? args.sessionScope.trim() : '';
  if (normalizedSessionScope && shouldUnbindConversationSessionOnInjectFailure(reason)) {
    try {
      getClockClientRegistry().unbindSessionScope(normalizedSessionScope);
    } catch {
      // best-effort cleanup only
    }
  }

  throw createClientInjectFailureError({
    reason,
    source: args.source,
    requestId: args.requestId,
    sessionId: args.sessionScope,
    tmuxSessionId: args.tmuxSessionId,
    code: args.failureCode,
    upstreamCode: args.failureUpstreamCode,
    status: args.failureStatus
  });
}

function buildInjectTargetFromMetadata(args: {
  metadata: Record<string, unknown>;
  requestId: string;
}): ClientInjectionTarget {
  const tmuxSessionId =
    typeof args.metadata.clientTmuxSessionId === 'string'
      ? args.metadata.clientTmuxSessionId
      : (typeof args.metadata.client_tmux_session_id === 'string'
        ? args.metadata.client_tmux_session_id
        : (typeof args.metadata.tmuxSessionId === 'string' ? args.metadata.tmuxSessionId : undefined));
  const tmuxTarget =
    typeof args.metadata.clientTmuxTarget === 'string'
      ? args.metadata.clientTmuxTarget
      : (typeof args.metadata.client_tmux_target === 'string'
        ? args.metadata.client_tmux_target
        : (typeof args.metadata.tmuxTarget === 'string' ? args.metadata.tmuxTarget : undefined));
  const clientType =
    typeof args.metadata.clockClientType === 'string'
      ? args.metadata.clockClientType
      : (typeof args.metadata.clientType === 'string' ? args.metadata.clientType : undefined);
  return {
    ...(tmuxSessionId ? { tmuxSessionId } : {}),
    ...(tmuxTarget ? { tmuxTarget } : {}),
    ...(clientType ? { clientType } : {}),
    workdir:
      typeof args.metadata.clientWorkdir === 'string'
        ? args.metadata.clientWorkdir
        : (typeof args.metadata.client_workdir === 'string'
          ? args.metadata.client_workdir
          : (typeof args.metadata.workdir === 'string' ? args.metadata.workdir : undefined)),
    requestId: args.requestId
  };
}

function extractUserAndToolSignals(requestBody: Record<string, unknown>): {
  userText: string;
  hasClockDirective: boolean;
  continueExecutionToolCalled: boolean;
} {
  const messages = Array.isArray(requestBody.messages) ? (requestBody.messages as unknown[]) : [];
  const lastUser = [...messages]
    .reverse()
    .find((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).role === 'user') as
    | Record<string, unknown>
    | undefined;
  const userText = typeof lastUser?.content === 'string' ? String(lastUser.content) : '';

  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined;
  const lastTool =
    lastMessage && typeof lastMessage === 'object' && !Array.isArray(lastMessage)
      ? (lastMessage as Record<string, unknown>)
      : undefined;
  const lastToolRole = typeof lastTool?.role === 'string' ? lastTool.role : '';
  const lastToolName = typeof lastTool?.name === 'string' ? String(lastTool.name).trim() : '';

  return {
    userText,
    hasClockDirective: userText.includes('<**clock:{') && userText.includes('}**>'),
    continueExecutionToolCalled: lastToolRole === 'tool' && lastToolName === 'continue_execution'
  };
}

export function resolveStopMessageClientInjectReadiness(
  metadata: Record<string, unknown>
): StopMessageClientInjectReadiness {
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
  const explicitReason =
      typeof metadata.clientInjectReason === 'string'
        ? metadata.clientInjectReason.trim()
        : (typeof metadata.client_inject_reason === 'string' ? metadata.client_inject_reason.trim() : '');
  if (explicitClientInjectReady === false && shouldTreatExplicitUnreadyAsHardBlock(explicitReason)) {
    return { ready: false, reason: explicitReason || 'client_inject_unready' };
  }

  const tmuxSessionId =
    normalizeInjectToken(metadata.clientTmuxSessionId) ||
    normalizeInjectToken(metadata.client_tmux_session_id) ||
    normalizeInjectToken(metadata.tmuxSessionId);
  const sessionScope = resolveInjectConversationSessionId(metadata);
  const daemonId =
    normalizeInjectToken(metadata.clientDaemonId) ||
    normalizeInjectToken(metadata.client_daemon_id) ||
    normalizeInjectToken(metadata.clockDaemonId) ||
    normalizeInjectToken(metadata.clockClientDaemonId);
  const workdir = resolveInjectWorkdir(metadata);
  const clientType = normalizeInjectToken(metadata.clockClientType) || normalizeInjectToken(metadata.clientType);

  if (tmuxSessionId) {
    return { ready: true, reason: 'tmux_direct', tmuxSessionId, ...(sessionScope ? { sessionScope } : {}) };
  }
  void daemonId;
  void workdir;
  void clientType;
  return {
    ready: false,
    reason: 'tmux_session_required',
    ...(sessionScope ? { sessionScope } : {})
  };
}

export async function runClientInjectionFlowBeforeReenter(args: {
  nestedMetadata: Record<string, unknown>;
  requestBody: Record<string, unknown>;
  requestId: string;
}): Promise<{ clientInjectOnlyHandled: boolean }> {
  const clientInjectOnlyRaw = args.nestedMetadata.clientInjectOnly;
  const clientInjectOnly =
    clientInjectOnlyRaw === true ||
    (typeof clientInjectOnlyRaw === 'string' && clientInjectOnlyRaw.trim().toLowerCase() === 'true');
  const clientInjectText =
    typeof args.nestedMetadata.clientInjectText === 'string' ? args.nestedMetadata.clientInjectText.trim() : '';
  const clientInjectSource =
    typeof args.nestedMetadata.clientInjectSource === 'string' && args.nestedMetadata.clientInjectSource.trim()
      ? args.nestedMetadata.clientInjectSource.trim()
      : 'servertool.client_inject';

  const injectTarget = buildInjectTargetFromMetadata({
    metadata: args.nestedMetadata,
    requestId: args.requestId
  });

  const signals = extractUserAndToolSignals(args.requestBody);
  bindClockConversationSession(args.nestedMetadata);

  const resolveStrictTarget = (source: string): StrictClientInjectTarget =>
    resolveStrictClientInjectTarget({
      tmuxSessionId: injectTarget.tmuxSessionId,
      conversationSessionId:
        typeof args.nestedMetadata.stopMessageClientInjectSessionScope === 'string'
          ? args.nestedMetadata.stopMessageClientInjectSessionScope
          : typeof args.nestedMetadata.stopMessageClientInjectScope === 'string'
            ? args.nestedMetadata.stopMessageClientInjectScope
            : undefined,
      clientInjectReady: args.nestedMetadata.clientInjectReady ?? args.nestedMetadata.client_inject_ready,
      clientInjectReason: args.nestedMetadata.clientInjectReason ?? args.nestedMetadata.client_inject_reason,
      requestId: args.requestId,
      source
    });

  if (clientInjectOnly) {
    const strictTarget = resolveStrictTarget(clientInjectSource);

    await injectClientPromptStrict({
      tmuxSessionId: strictTarget.tmuxSessionId,
      sessionScope: strictTarget.sessionScope,
      ...(injectTarget.tmuxTarget ? { tmuxTarget: injectTarget.tmuxTarget } : {}),
      ...(injectTarget.clientType ? { clientType: injectTarget.clientType } : {}),
      workdir: injectTarget.workdir,
      requestId: injectTarget.requestId,
      text: clientInjectText || signals.userText || '继续执行',
      source: clientInjectSource
    });
    return { clientInjectOnlyHandled: true };
  }

  if (signals.hasClockDirective) {
    const strictTarget = resolveStrictTarget('servertool.clock');
    await injectClientPromptStrict({
      tmuxSessionId: strictTarget.tmuxSessionId,
      sessionScope: strictTarget.sessionScope,
      ...(injectTarget.tmuxTarget ? { tmuxTarget: injectTarget.tmuxTarget } : {}),
      ...(injectTarget.clientType ? { clientType: injectTarget.clientType } : {}),
      workdir: injectTarget.workdir,
      requestId: injectTarget.requestId,
      text: signals.userText,
      source: 'servertool.clock'
    });
  }

  if (signals.continueExecutionToolCalled) {
    const strictTarget = resolveStrictTarget('servertool.continue_execution');
    await injectClientPromptStrict({
      tmuxSessionId: strictTarget.tmuxSessionId,
      sessionScope: strictTarget.sessionScope,
      ...(injectTarget.tmuxTarget ? { tmuxTarget: injectTarget.tmuxTarget } : {}),
      ...(injectTarget.clientType ? { clientType: injectTarget.clientType } : {}),
      workdir: injectTarget.workdir,
      requestId: injectTarget.requestId,
      text: '继续执行',
      source: 'servertool.continue_execution'
    });
  }

  if (signals.hasClockDirective || signals.continueExecutionToolCalled) {
    return { clientInjectOnlyHandled: true };
  }

  return { clientInjectOnlyHandled: false };
}
