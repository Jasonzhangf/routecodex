import type { PipelineExecutionInput } from '../../handlers/types.js';
import { asRecord } from './provider-utils.js';
import { extractSessionIdentifiersFromMetadata } from '../../../modules/llmswitch/bridge.js';
import { extractClockClientDaemonIdFromApiKey } from '../../../utils/clock-client-token.js';
import {
  shouldTraceClockScopeByContext
} from '../../../utils/clock-scope-trace.js';
import { getClockClientRegistry } from './clock-client-registry.js';
import { resolveTmuxSessionIdAndSource } from './clock-scope-resolution.js';

export function cloneClientHeaders(source: unknown): Record<string, string> | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim()) {
      normalized[key] = value;
    }
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

export function ensureClientHeadersOnPayload(payload: unknown, headers: Record<string, string>): void {
  if (!payload || typeof payload !== 'object') {
    return;
  }
  const carrier = payload as { metadata?: Record<string, unknown> };
  const existing =
    carrier.metadata && typeof carrier.metadata === 'object'
      ? carrier.metadata
      : {};
  carrier.metadata = {
    ...existing,
    clientHeaders: existing.clientHeaders ?? headers
  };
}

export function resolveClientRequestId(metadata: Record<string, unknown>, fallback: string): string {
  const clientRequestId =
    typeof metadata.clientRequestId === 'string' && metadata.clientRequestId.trim()
      ? metadata.clientRequestId.trim()
      : undefined;
  return clientRequestId || fallback;
}

function extractClockDaemonId(
  userMeta: Record<string, unknown>,
  headers: Record<string, unknown> | undefined
): string | undefined {
  const fromMeta =
    (typeof userMeta.clientDaemonId === 'string' && userMeta.clientDaemonId.trim())
      ? userMeta.clientDaemonId.trim()
      : ((typeof userMeta.client_daemon_id === 'string' && userMeta.client_daemon_id.trim())
        ? userMeta.client_daemon_id.trim()
        : ((typeof userMeta.clockDaemonId === 'string' && userMeta.clockDaemonId.trim())
          ? userMeta.clockDaemonId.trim()
          : ((typeof userMeta.clockClientDaemonId === 'string' && userMeta.clockClientDaemonId.trim())
            ? userMeta.clockClientDaemonId.trim()
            : undefined)));
  if (fromMeta) {
    return fromMeta;
  }

  const fromLegacyMeta =
    (typeof userMeta.clockDaemonId === 'string' && userMeta.clockDaemonId.trim())
      ? userMeta.clockDaemonId.trim()
      : ((typeof userMeta.clockClientDaemonId === 'string' && userMeta.clockClientDaemonId.trim())
        ? userMeta.clockClientDaemonId.trim()
        : undefined);
  if (fromLegacyMeta) {
    return fromLegacyMeta;
  }

  const fromExplicitHeader =
    extractHeaderValue(headers, 'x-routecodex-client-daemon-id')
    || extractHeaderValue(headers, 'x-routecodex-clientd-id')
    || extractHeaderValue(headers, 'x-routecodex-clock-daemon-id')
    || extractHeaderValue(headers, 'x-routecodex-daemon-id');
  if (fromExplicitHeader) {
    return fromExplicitHeader;
  }

  const fromApiKeyHeader =
    extractHeaderValue(headers, 'x-routecodex-api-key')
    || extractHeaderValue(headers, 'x-api-key')
    || extractHeaderValue(headers, 'x-routecodex-apikey')
    || extractHeaderValue(headers, 'api-key')
    || extractHeaderValue(headers, 'apikey');
  const fromApiKey = extractClockClientDaemonIdFromApiKey(fromApiKeyHeader);
  if (fromApiKey) {
    return fromApiKey;
  }

  const authorization = extractHeaderValue(headers, 'authorization');
  if (authorization) {
    const match = authorization.match(/^(?:Bearer|ApiKey)\s+(.+)$/i);
    const fromAuth = extractClockClientDaemonIdFromApiKey(match ? String(match[1]) : authorization);
    if (fromAuth) {
      return fromAuth;
    }
  }

  return undefined;
}

function extractSessionTokenFromBodyMeta(meta: Record<string, unknown>): { sessionId?: string; conversationId?: string } {
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = meta[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return undefined;
  };

  const explicitSessionId = pick('sessionId', 'session_id');
  const explicitConversationId = pick('conversationId', 'conversation_id');
  const userId = pick('user_id');
  const userIdSessionMatch = userId ? userId.match(/(?:^|[_-])session[_-]([a-z0-9-]{8,})/i) : null;
  const derivedSessionId = userIdSessionMatch?.[1]?.trim();

  const sessionId = explicitSessionId || derivedSessionId;
  const conversationId = explicitConversationId || sessionId;
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(conversationId ? { conversationId } : {})
  };
}

function extractSessionTokenFromHeaderSources(
  headers: Record<string, unknown> | undefined,
  clientHeaders?: Record<string, string>
): { sessionId?: string; conversationId?: string } {
  const sources: Array<Record<string, unknown> | undefined> = [
    headers,
    clientHeaders as unknown as Record<string, unknown> | undefined
  ];
  let sessionId: string | undefined;
  let conversationId: string | undefined;
  for (const source of sources) {
    if (!source) {
      continue;
    }
    if (!sessionId) {
      sessionId =
        extractHeaderValue(source, 'session_id')
        || extractHeaderValue(source, 'session-id')
        || extractHeaderValue(source, 'x-session-id')
        || extractHeaderValue(source, 'anthropic-session-id')
        || undefined;
    }
    if (!conversationId) {
      conversationId =
        extractHeaderValue(source, 'conversation_id')
        || extractHeaderValue(source, 'conversation-id')
        || extractHeaderValue(source, 'x-conversation-id')
        || extractHeaderValue(source, 'anthropic-conversation-id')
        || extractHeaderValue(source, 'openai-conversation-id')
        || undefined;
    }
  }
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(conversationId ? { conversationId } : {})
  };
}

function extractWorkdir(
  userMeta: Record<string, unknown>,
  bodyMeta: Record<string, unknown>,
  headers: Record<string, unknown> | undefined,
  clientHeaders?: Record<string, string>
): string | undefined {
  const directCandidates = [
    userMeta.workdir,
    userMeta.cwd,
    userMeta.workingDirectory,
    bodyMeta.workdir,
    bodyMeta.cwd,
    bodyMeta.workingDirectory
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  const headerSources: Array<Record<string, unknown> | undefined> = [
    headers,
    clientHeaders ? (clientHeaders as unknown as Record<string, unknown>) : undefined
  ];
  for (const source of headerSources) {
    const fromHeader =
      extractHeaderValue(source, 'x-routecodex-workdir')
      || extractHeaderValue(source, 'x-rcc-workdir')
      || extractHeaderValue(source, 'x-workdir');
    if (fromHeader) {
      return fromHeader;
    }
    const fromTurnMetadata = extractWorkdirFromTurnMetadata(
      extractHeaderValue(source, 'x-codex-turn-metadata')
    );
    if (fromTurnMetadata) {
      return fromTurnMetadata;
    }
  }

  return undefined;
}

function extractWorkdirFromTurnMetadata(rawTurnMetadata: string | undefined): string | undefined {
  if (!rawTurnMetadata) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(rawTurnMetadata) as Record<string, unknown>;
    const direct =
      (typeof parsed.workdir === 'string' && parsed.workdir.trim())
      || (typeof parsed.cwd === 'string' && parsed.cwd.trim())
      || (typeof parsed.workingDirectory === 'string' && parsed.workingDirectory.trim())
      || (typeof parsed.working_directory === 'string' && parsed.working_directory.trim())
      || undefined;
    if (direct) {
      return direct;
    }
    const workspaces = parsed.workspaces;
    if (!workspaces || typeof workspaces !== 'object' || Array.isArray(workspaces)) {
      return undefined;
    }
    const workspaceKeys = Object.keys(workspaces)
      .map((entry) => entry.trim())
      .filter((entry) => entry.startsWith('/'));
    if (workspaceKeys.length === 1) {
      return workspaceKeys[0];
    }
    if (workspaceKeys.length > 1) {
      // Prefer the most specific path when multiple workspaces are present.
      return workspaceKeys.sort((a, b) => b.length - a.length)[0];
    }
  } catch {
    // ignore invalid turn metadata payload
  }
  return undefined;
}

function normalizeToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function inferClockClientType(metadata: Record<string, unknown>): string | undefined {
  const direct =
    normalizeToken(metadata.clockClientType)
    || normalizeToken(metadata.clientType);
  if (direct) {
    return direct;
  }
  const userAgent = normalizeToken(metadata.userAgent)?.toLowerCase() || '';
  const originator = normalizeToken(metadata.clientOriginator)?.toLowerCase() || '';
  if (originator.includes('codex') || userAgent.includes('codex')) {
    return 'codex';
  }
  if (originator.includes('claude') || userAgent.includes('claude')) {
    return 'claude';
  }
  return undefined;
}

function resolveWorkdirFromClockDaemon(daemonId: string | undefined): string | undefined {
  if (!daemonId) {
    return undefined;
  }
  try {
    const record = getClockClientRegistry().findByDaemonId(daemonId);
    const workdir = typeof record?.workdir === 'string' ? record.workdir.trim() : '';
    return workdir || undefined;
  } catch {
    return undefined;
  }
}

function resolveTmuxSessionIdFromClockDaemon(daemonId: string | undefined): string | undefined {
  if (!daemonId) {
    return undefined;
  }
  try {
    const record = getClockClientRegistry().findByDaemonId(daemonId);
    const tmuxSessionId = typeof record?.tmuxSessionId === 'string' ? record.tmuxSessionId.trim() : '';
    if (tmuxSessionId) {
      return tmuxSessionId;
    }
    const sessionId = typeof record?.sessionId === 'string' ? record.sessionId.trim() : '';
    return sessionId || undefined;
  } catch {
    return undefined;
  }
}

function resolveTmuxTargetFromClockDaemon(daemonId: string | undefined): string | undefined {
  if (!daemonId) {
    return undefined;
  }
  try {
    const record = getClockClientRegistry().findByDaemonId(daemonId);
    const tmuxTarget = typeof record?.tmuxTarget === 'string' ? record.tmuxTarget.trim() : '';
    return tmuxTarget || undefined;
  } catch {
    return undefined;
  }
}

function shouldTraceClockScopeMetadata(args: {
  entryEndpoint: string;
  userAgent?: string;
  originator?: string;
  clientHeaders?: Record<string, string>;
}): boolean {
  const hasTurnMeta = typeof args.clientHeaders?.['x-codex-turn-metadata'] === 'string'
    && args.clientHeaders['x-codex-turn-metadata'].trim().length > 0;
  return shouldTraceClockScopeByContext({
    endpointOrPath: args.entryEndpoint || '',
    userAgent: args.userAgent,
    originator: args.originator,
    hasTurnMetadata: hasTurnMeta
  });
}

function logClockScopeMetadata(args: {
  requestId?: string;
  entryEndpoint: string;
  userAgent?: string;
  originator?: string;
  resolvedClockDaemonId?: string;
  resolvedTmuxSessionId?: string;
  resolvedWorkdir?: string;
  clientInjectReady: boolean;
  tmuxSource?: string;
}): void {
  console.log(
    `[clock-scope][metadata] requestId=${args.requestId || 'n/a'} endpoint=${args.entryEndpoint || 'n/a'} ` +
    `daemon=${args.resolvedClockDaemonId || 'none'} tmux=${args.resolvedTmuxSessionId || 'none'} ` +
    `ready=${args.clientInjectReady ? 'yes' : 'no'} workdir=${args.resolvedWorkdir || 'none'} ` +
    `originator=${args.originator || 'n/a'} ua=${args.userAgent || 'n/a'} ` +
    `tmuxSource=${args.tmuxSource || 'none'}`
  );
}

export function buildRequestMetadata(input: PipelineExecutionInput): Record<string, unknown> {
  const userMeta = asRecord(input.metadata);
  const bodyMeta = asRecord(asRecord(input.body).metadata);
  const headers = asRecord(input.headers);
  const inboundUserAgent = extractHeaderValue(headers, 'user-agent');
  const inboundOriginator = extractHeaderValue(headers, 'originator');
  const normalizedClientHeaders =
    cloneClientHeaders((userMeta as { clientHeaders?: unknown }).clientHeaders) ||
    cloneClientHeaders(
      (headers?.['clientHeaders'] as Record<string, unknown> | undefined) ?? undefined
    );
  const resolvedUserAgent =
    typeof userMeta.userAgent === 'string' && userMeta.userAgent.trim()
      ? userMeta.userAgent.trim()
      : inboundUserAgent;
  const resolvedOriginator =
    typeof userMeta.clientOriginator === 'string' && userMeta.clientOriginator.trim()
      ? userMeta.clientOriginator.trim()
      : inboundOriginator;
  const routeHint = extractRouteHint(input) ?? userMeta.routeHint;
  const processMode = (userMeta.processMode as string) || 'chat';
  let resolvedClockDaemonId = extractClockDaemonId(userMeta, headers);
  const inferredClientType = inferClockClientType(userMeta);
  const resolvedTmuxTarget =
    normalizeToken(userMeta.clientTmuxTarget)
    || normalizeToken(userMeta.client_tmux_target)
    || normalizeToken(userMeta.tmuxTarget)
    || normalizeToken(bodyMeta.clientTmuxTarget)
    || normalizeToken(bodyMeta.client_tmux_target)
    || normalizeToken(bodyMeta.tmuxTarget)
    || resolveTmuxTargetFromClockDaemon(resolvedClockDaemonId);
  const resolvedWorkdir =
    extractWorkdir(userMeta, bodyMeta, headers, normalizedClientHeaders)
    || resolveWorkdirFromClockDaemon(resolvedClockDaemonId);
  const tmuxResolution = resolveTmuxSessionIdAndSource({
    userMeta,
    bodyMeta,
    headers: headers ?? undefined,
    clientHeaders: normalizedClientHeaders,
    daemonId: resolvedClockDaemonId,
    resolveTmuxSessionIdFromDaemon: resolveTmuxSessionIdFromClockDaemon
  });
  let resolvedTmuxSessionId = tmuxResolution.tmuxSessionId;
  let tmuxSource = tmuxResolution.source;
  let clientInjectReady = Boolean(resolvedTmuxSessionId);
  let clientInjectReason = clientInjectReady ? 'tmux_session_ready' : 'tmux_session_missing';
  let stopMessageClientInjectSessionScope = resolvedTmuxSessionId ? `tmux:${resolvedTmuxSessionId}` : undefined;
  const metadata: Record<string, unknown> = {
    ...userMeta,
    entryEndpoint: input.entryEndpoint,
    processMode,
    direction: 'request',
    stage: 'inbound',
    routeHint,
    stream: userMeta.stream === true,
    ...(resolvedUserAgent ? { userAgent: resolvedUserAgent } : {}),
    ...(resolvedOriginator ? { clientOriginator: resolvedOriginator } : {}),
    ...(resolvedClockDaemonId
      ? {
          clientDaemonId: resolvedClockDaemonId,
          clockDaemonId: resolvedClockDaemonId,
          clockClientDaemonId: resolvedClockDaemonId
        }
      : {}),
    ...(resolvedWorkdir
      ? {
          clientWorkdir: resolvedWorkdir,
          workdir: resolvedWorkdir
        }
      : {}),
    ...(resolvedTmuxSessionId
      ? {
          clientTmuxSessionId: resolvedTmuxSessionId,
          tmuxSessionId: resolvedTmuxSessionId
        }
      : {}),
    ...(resolvedTmuxTarget
      ? {
          clientTmuxTarget: resolvedTmuxTarget,
          tmuxTarget: resolvedTmuxTarget
        }
      : {}),
    ...(inferredClientType
      ? {
          clockClientType: inferredClientType,
          clientType: inferredClientType
        }
      : {}),
    ...(stopMessageClientInjectSessionScope
      ? { stopMessageClientInjectSessionScope }
      : {}),
    clientInjectReady,
    clientInjectReason
  };

  if (normalizedClientHeaders) {
    metadata.clientHeaders = normalizedClientHeaders;
  }

  const sessionIdentifierSource: Record<string, unknown> = {
    ...bodyMeta,
    ...metadata
  };
  const sessionIdentifiers = extractSessionIdentifiersFromMetadata(sessionIdentifierSource);
  if (sessionIdentifiers.sessionId) {
    metadata.sessionId = sessionIdentifiers.sessionId;
  }
  if (sessionIdentifiers.conversationId) {
    metadata.conversationId = sessionIdentifiers.conversationId;
  }
  if (!metadata.sessionId || !metadata.conversationId) {
    const fallback = extractSessionTokenFromBodyMeta(bodyMeta);
    if (!metadata.sessionId && fallback.sessionId) {
      metadata.sessionId = fallback.sessionId;
    }
    if (!metadata.conversationId && fallback.conversationId) {
      metadata.conversationId = fallback.conversationId;
    }
  }

  if (!metadata.sessionId || !metadata.conversationId) {
    const fromHeaders = extractSessionTokenFromHeaderSources(headers, normalizedClientHeaders);
    if (!metadata.sessionId && fromHeaders.sessionId) {
      metadata.sessionId = fromHeaders.sessionId;
    }
    if (!metadata.conversationId && fromHeaders.conversationId) {
      metadata.conversationId = fromHeaders.conversationId;
    }
    if (!metadata.conversationId && metadata.sessionId) {
      metadata.conversationId = String(metadata.sessionId);
    }
  }

  if (!resolvedTmuxSessionId) {
    const conversationSessionId =
      normalizeToken(metadata.sessionId)
      || normalizeToken(metadata.conversationId);
    if (conversationSessionId && resolvedWorkdir) {
      const bindResult = getClockClientRegistry().bindConversationSession({
        conversationSessionId,
        ...(resolvedClockDaemonId ? { daemonId: resolvedClockDaemonId } : {}),
        workdir: resolvedWorkdir,
        ...(inferredClientType ? { clientType: inferredClientType } : {})
      });
      if (bindResult.ok && bindResult.tmuxSessionId) {
        resolvedTmuxSessionId = bindResult.tmuxSessionId;
        tmuxSource = 'registry_by_binding';
        clientInjectReady = true;
        clientInjectReason = 'tmux_session_ready';
        stopMessageClientInjectSessionScope = `tmux:${resolvedTmuxSessionId}`;
        metadata.clientTmuxSessionId = resolvedTmuxSessionId;
        metadata.tmuxSessionId = resolvedTmuxSessionId;
        metadata.stopMessageClientInjectSessionScope = stopMessageClientInjectSessionScope;
        metadata.clientInjectReady = true;
        metadata.clientInjectReason = 'tmux_session_ready';
        if (!resolvedClockDaemonId && bindResult.daemonId) {
          resolvedClockDaemonId = bindResult.daemonId;
          metadata.clientDaemonId = bindResult.daemonId;
          metadata.clockDaemonId = bindResult.daemonId;
          metadata.clockClientDaemonId = bindResult.daemonId;
        }
      }
    }
  }

  if (shouldTraceClockScopeMetadata({
    entryEndpoint: input.entryEndpoint,
    userAgent: resolvedUserAgent,
    originator: resolvedOriginator,
    clientHeaders: normalizedClientHeaders
  })) {
    logClockScopeMetadata({
      requestId: input.requestId,
      entryEndpoint: input.entryEndpoint,
      userAgent: resolvedUserAgent,
      originator: resolvedOriginator,
      resolvedClockDaemonId,
      resolvedTmuxSessionId,
      resolvedWorkdir,
      clientInjectReady,
      tmuxSource
    });
  }

  return metadata;
}

export function decorateMetadataForAttempt(
  base: Record<string, unknown>,
  attempt: number,
  excludedProviderKeys: Set<string>
): Record<string, unknown> {
  const clone = cloneMetadata(base);
  clone.retryAttempt = attempt;
  if (excludedProviderKeys.size > 0) {
    clone.excludedProviderKeys = Array.from(excludedProviderKeys);
  } else if (clone.excludedProviderKeys) {
    delete clone.excludedProviderKeys;
  }
  return clone;
}

function extractHeaderValue(
  headers: Record<string, unknown> | undefined,
  name: string
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) {
      continue;
    }
    if (typeof value === 'string') {
      return value.trim() || undefined;
    }
    if (Array.isArray(value) && value.length) {
      return String(value[0]).trim() || undefined;
    }
    return undefined;
  }
  return undefined;
}

function extractRouteHint(input: PipelineExecutionInput): string | undefined {
  const header = (input.headers as Record<string, unknown>)?.['x-route-hint'];
  if (typeof header === 'string' && header.trim()) {
    return header.trim();
  }
  if (Array.isArray(header) && header[0]) {
    return String(header[0]);
  }
  return undefined;
}

function cloneMetadata(source: Record<string, unknown>): Record<string, unknown> {
  const structuredCloneFn = (globalThis as { structuredClone?: <T>(value: T) => T }).structuredClone;
  if (typeof structuredCloneFn === 'function') {
    try {
      return structuredCloneFn(source);
    } catch {
      // fall through to JSON fallback
    }
  }
  try {
    return JSON.parse(JSON.stringify(source));
  } catch {
    return { ...source };
  }
}
