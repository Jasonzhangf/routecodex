import type { PipelineExecutionInput } from '../../handlers/types.js';
import { asRecord } from './provider-utils.js';
import { extractSessionIdentifiersFromMetadata } from '../../../modules/llmswitch/bridge.js';
import { extractClockClientDaemonIdFromApiKey } from '../../../utils/clock-client-token.js';
import { getClockClientRegistry } from './clock-client-registry.js';

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
    (typeof userMeta.clockDaemonId === 'string' && userMeta.clockDaemonId.trim())
      ? userMeta.clockDaemonId.trim()
      : ((typeof userMeta.clockClientDaemonId === 'string' && userMeta.clockClientDaemonId.trim())
        ? userMeta.clockClientDaemonId.trim()
        : undefined);
  if (fromMeta) {
    return fromMeta;
  }

  const fromExplicitHeader =
    extractHeaderValue(headers, 'x-routecodex-clock-daemon-id')
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
  }

  return undefined;
}

function extractTmuxSessionId(
  userMeta: Record<string, unknown>,
  bodyMeta: Record<string, unknown>,
  headers: Record<string, unknown> | undefined,
  clientHeaders?: Record<string, string>
): string | undefined {
  const directCandidates = [
    userMeta.tmuxSessionId,
    userMeta.tmux_session_id,
    bodyMeta.tmuxSessionId,
    bodyMeta.tmux_session_id
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
      extractHeaderValue(source, 'x-routecodex-tmux-session-id')
      || extractHeaderValue(source, 'x-rcc-tmux-session-id')
      || extractHeaderValue(source, 'x-tmux-session-id');
    if (fromHeader) {
      return fromHeader;
    }
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
  const resolvedClockDaemonId = extractClockDaemonId(userMeta, headers);
  const resolvedWorkdir =
    extractWorkdir(userMeta, bodyMeta, headers, normalizedClientHeaders)
    || resolveWorkdirFromClockDaemon(resolvedClockDaemonId);
  const resolvedTmuxSessionId =
    extractTmuxSessionId(userMeta, bodyMeta, headers, normalizedClientHeaders)
    || resolveTmuxSessionIdFromClockDaemon(resolvedClockDaemonId);
  const clientInjectReady = Boolean(resolvedTmuxSessionId);
  const clientInjectReason = clientInjectReady ? 'tmux_session_ready' : 'tmux_session_missing';
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
    ...(resolvedClockDaemonId ? { clockDaemonId: resolvedClockDaemonId } : {}),
    ...(resolvedWorkdir ? { workdir: resolvedWorkdir } : {}),
    ...(resolvedTmuxSessionId ? { tmuxSessionId: resolvedTmuxSessionId } : {}),
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
