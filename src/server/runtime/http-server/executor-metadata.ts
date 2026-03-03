import type { PipelineExecutionInput } from '../../handlers/types.js';
import { asRecord } from './provider-utils.js';
import { extractSessionIdentifiersFromMetadata } from '../../../modules/llmswitch/bridge.js';
import { extractSessionClientDaemonIdFromApiKey } from '../../../utils/session-client-token.js';
import {
  shouldTraceSessionScopeByContext
} from '../../../utils/session-scope-trace.js';
import { getSessionClientRegistry } from './session-client-registry.js';
import { resolveTmuxSessionIdAndSource } from './session-scope-resolution.js';
import { isTmuxSessionAlive } from './tmux-session-probe.js';

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

function extractSessionDaemonId(
  userMeta: Record<string, unknown>,
  headers: Record<string, unknown> | undefined
): string | undefined {
  const fromMeta =
    (typeof userMeta.clientDaemonId === 'string' && userMeta.clientDaemonId.trim())
      ? userMeta.clientDaemonId.trim()
      : ((typeof userMeta.client_daemon_id === 'string' && userMeta.client_daemon_id.trim())
        ? userMeta.client_daemon_id.trim()
        : ((typeof userMeta.sessionDaemonId === 'string' && userMeta.sessionDaemonId.trim())
          ? userMeta.sessionDaemonId.trim()
          : ((typeof userMeta.sessionClientDaemonId === 'string' && userMeta.sessionClientDaemonId.trim())
            ? userMeta.sessionClientDaemonId.trim()
            : undefined)));
  if (fromMeta) {
    return fromMeta;
  }

  const fromExplicitHeader =
    extractHeaderValue(headers, 'x-routecodex-client-daemon-id')
    || extractHeaderValue(headers, 'x-routecodex-clientd-id')
    || extractHeaderValue(headers, 'x-routecodex-session-daemon-id')
    || extractHeaderValue(headers, 'x-routecodex-sessiond-id')
    || extractHeaderValue(headers, 'x-rcc-session-daemon-id')
    || extractHeaderValue(headers, 'x-rcc-sessiond-id')
    || extractHeaderValue(headers, 'x-rcc-daemon-id')
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
  const fromApiKey = extractSessionClientDaemonIdFromApiKey(fromApiKeyHeader);
  if (fromApiKey) {
    return fromApiKey;
  }

  const authorization = extractHeaderValue(headers, 'authorization');
  if (authorization) {
    const match = authorization.match(/^(?:Bearer|ApiKey)\s+(.+)$/i);
    const fromAuth = extractSessionClientDaemonIdFromApiKey(match ? String(match[1]) : authorization);
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
  const candidates = [rawTurnMetadata];
  try {
    candidates.push(decodeURIComponent(rawTurnMetadata));
  } catch {
    // ignore URI decode failures
  }
  for (const candidate of [...candidates]) {
    const normalized = candidate.trim();
    if (!normalized) {
      continue;
    }
    if (!/^[A-Za-z0-9+/=_-]+$/.test(normalized) || normalized.length < 12) {
      continue;
    }
    try {
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
      const decoded = Buffer.from(padded, 'base64').toString('utf8').trim();
      if (decoded) {
        candidates.push(decoded);
      }
    } catch {
      // ignore base64 decoding errors
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const fromJson = extractWorkdirFromTurnMetadataObject(parsed);
      if (fromJson) {
        return fromJson;
      }
    } catch {
      // continue to querystring parsing
    }

    try {
      const params = new URLSearchParams(candidate);
      const fromParams =
        (params.get('workdir') || '').trim()
        || (params.get('cwd') || '').trim()
        || (params.get('workingDirectory') || '').trim()
        || (params.get('working_directory') || '').trim();
      if (fromParams) {
        return fromParams;
      }
    } catch {
      // ignore non-URLSearchParams text
    }
  }
  return undefined;
}

function extractWorkdirFromTurnMetadataObject(parsed: Record<string, unknown>): string | undefined {
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
  return undefined;
}

function normalizeToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function inferSessionClientType(metadata: Record<string, unknown>): string | undefined {
  const direct =
    normalizeToken(metadata.sessionClientType)
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

function resolveWorkdirFromSessionDaemon(daemonId: string | undefined): string | undefined {
  if (!daemonId) {
    return undefined;
  }
  try {
    const record = getSessionClientRegistry().findByDaemonId(daemonId);
    const workdir = typeof record?.workdir === 'string' ? record.workdir.trim() : '';
    return workdir || undefined;
  } catch {
    return undefined;
  }
}

function resolveTmuxSessionIdFromSessionDaemon(daemonId: string | undefined): string | undefined {
  if (!daemonId) {
    return undefined;
  }
  try {
    const record = getSessionClientRegistry().findByDaemonId(daemonId);
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

function resolveTmuxTargetFromSessionDaemon(daemonId: string | undefined): string | undefined {
  if (!daemonId) {
    return undefined;
  }
  try {
    const record = getSessionClientRegistry().findByDaemonId(daemonId);
    const tmuxTarget = typeof record?.tmuxTarget === 'string' ? record.tmuxTarget.trim() : '';
    return tmuxTarget || undefined;
  } catch {
    return undefined;
  }
}

function shouldTraceSessionScopeMetadata(args: {
  entryEndpoint: string;
  userAgent?: string;
  originator?: string;
  clientHeaders?: Record<string, string>;
}): boolean {
  const hasTurnMeta = typeof args.clientHeaders?.['x-codex-turn-metadata'] === 'string'
    && args.clientHeaders['x-codex-turn-metadata'].trim().length > 0;
  return shouldTraceSessionScopeByContext({
    endpointOrPath: args.entryEndpoint || '',
    userAgent: args.userAgent,
    originator: args.originator,
    hasTurnMetadata: hasTurnMeta
  });
}

function logSessionScopeMetadata(args: {
  requestId?: string;
  entryEndpoint: string;
  userAgent?: string;
  originator?: string;
  resolvedSessionDaemonId?: string;
  resolvedTmuxSessionId?: string;
  resolvedWorkdir?: string;
  clientInjectReady: boolean;
  tmuxSource?: string;
}): void {
  console.log(
    `[session-scope][metadata] requestId=${args.requestId || 'n/a'} endpoint=${args.entryEndpoint || 'n/a'} ` +
    `daemon=${args.resolvedSessionDaemonId || 'none'} tmux=${args.resolvedTmuxSessionId || 'none'} ` +
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
  let resolvedSessionDaemonId = extractSessionDaemonId(userMeta, headers);
  const inferredClientType = inferSessionClientType(userMeta);
  const resolvedTmuxTarget =
    normalizeToken(userMeta.clientTmuxTarget)
    || normalizeToken(userMeta.client_tmux_target)
    || normalizeToken(userMeta.tmuxTarget)
    || normalizeToken(bodyMeta.clientTmuxTarget)
    || normalizeToken(bodyMeta.client_tmux_target)
    || normalizeToken(bodyMeta.tmuxTarget)
    || resolveTmuxTargetFromSessionDaemon(resolvedSessionDaemonId);
  const resolvedWorkdir =
    extractWorkdir(userMeta, bodyMeta, headers, normalizedClientHeaders)
    || resolveWorkdirFromSessionDaemon(resolvedSessionDaemonId);
  const tmuxResolution = resolveTmuxSessionIdAndSource({
    userMeta,
    bodyMeta,
    headers: headers ?? undefined,
    clientHeaders: normalizedClientHeaders,
    daemonId: resolvedSessionDaemonId,
    resolveTmuxSessionIdFromDaemon: resolveTmuxSessionIdFromSessionDaemon
  });
  let resolvedTmuxSessionId = tmuxResolution.tmuxSessionId;
  let tmuxSource = tmuxResolution.source;
  let clientInjectReady = Boolean(resolvedTmuxSessionId);
  let clientInjectReason = clientInjectReady ? 'tmux_session_ready' : 'tmux_session_missing';
  let stopMessageClientInjectSessionScope = resolvedTmuxSessionId ? `tmux:${resolvedTmuxSessionId}` : undefined;
  if (resolvedTmuxSessionId && !isTmuxSessionAlive(resolvedTmuxSessionId)) {
    try {
      getSessionClientRegistry().unbindSessionScope(`tmux:${resolvedTmuxSessionId}`);
    } catch {
      // best-effort cleanup only
    }
    resolvedTmuxSessionId = undefined;
    tmuxSource = 'none';
    clientInjectReady = false;
    clientInjectReason = 'tmux_session_missing';
    stopMessageClientInjectSessionScope = undefined;
  }
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
    ...(resolvedSessionDaemonId
      ? {
          clientDaemonId: resolvedSessionDaemonId,
          sessionDaemonId: resolvedSessionDaemonId,
          sessionClientDaemonId: resolvedSessionDaemonId
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
          sessionClientType: inferredClientType,
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

  if (shouldTraceSessionScopeMetadata({
    entryEndpoint: input.entryEndpoint,
    userAgent: resolvedUserAgent,
    originator: resolvedOriginator,
    clientHeaders: normalizedClientHeaders
  })) {
    logSessionScopeMetadata({
      requestId: input.requestId,
      entryEndpoint: input.entryEndpoint,
      userAgent: resolvedUserAgent,
      originator: resolvedOriginator,
      resolvedSessionDaemonId,
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
