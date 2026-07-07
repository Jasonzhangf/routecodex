import type { PipelineExecutionInput } from '../../handlers/types.js';
// feature_id: hub.metadata_center_request_capture
import { asRecord } from './provider-utils.js';
import {
  extractSessionIdentifiersFromMetadata
} from '../../../modules/llmswitch/bridge.js';
import { MetadataCenter } from './metadata-center/metadata-center.js';
import {
  bindMetadataCenterRustMirror,
  releaseMetadataCenterSlot,
  writeMetadataCenterSlot
} from './metadata-center/dualwrite-api.js';
import {
  extractSessionClientDaemonIdFromApiKey,
  extractSessionClientScopeIdFromApiKey
} from '../../../utils/session-client-token.js';
import {
  shouldTraceSessionScopeByContext
} from '../../../utils/session-scope-trace.js';
import { formatUnknownError, isRecord } from '../../../utils/common-utils.js';
import { preserveLiveClientAbortCarriers } from './executor/request-executor-client-abort-block.js';
import { hasStoplessDirectiveInRequestPayload } from './executor/provider-response-shared-pure-blocks.js';
import { extractServertoolCliResultRouteHintFromRequestNative } from '../../../modules/llmswitch/bridge/native-exports.js';
import { readRuntimeControlProjection } from './metadata-center/request-truth-readers.js';

const ATTEMPT_METADATA_RUNTIME_CONTROL_RELEASE_WRITER = {
  module: 'src/server/runtime/http-server/executor-metadata.ts',
  symbol: 'decorateMetadataForAttempt',
  stage: 'request_executor_attempt_metadata'
} as const;

const BUILD_REQUEST_METADATA_WRITER = {
  module: 'src/server/runtime/http-server/executor-metadata.ts',
  symbol: 'buildRequestMetadata',
  stage: 'ServerReqInbound01ClientRaw'
} as const;

const BUILD_REQUEST_METADATA_INBOUND_WRITER = {
  module: 'src/server/runtime/http-server/executor-metadata.ts',
  symbol: 'buildRequestMetadata',
  stage: 'HubReqInbound02Standardized'
} as const;

const SYNTHETIC_SESSION_PREFIX = 'rcc-session';

export type InboundLogSessionContextInput = {
  entryEndpoint: string;
  headers?: Record<string, unknown>;
  bodyMetadata?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  portContext?: Record<string, unknown> | null;
};

function logExecutorMetadataNonBlocking(
  stage: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  try {
    const suffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[executor-metadata] ${stage} failed (non-blocking): ${formatUnknownError(error)}${suffix}`);
  } catch {
    // Never throw from non-blocking logging.
  }
}

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

function extractSessionScopeId(
  userMeta: Record<string, unknown>,
  headers: Record<string, unknown> | undefined,
  clientHeaders?: Record<string, string>
): string | undefined {
  const directCandidates = [
    userMeta.clientTmuxSessionId,
    userMeta.client_tmux_session_id,
    userMeta.tmuxSessionId,
    userMeta.tmux_session_id,
    userMeta.rccSessionClientTmuxSessionId,
    userMeta.rcc_session_client_tmux_session_id
  ];
  for (const candidate of directCandidates) {
    const normalized = normalizeToken(candidate);
    if (normalized) {
      return normalized;
    }
  }

  const headerSources: Array<Record<string, unknown> | undefined> = [
    headers,
    clientHeaders ? (clientHeaders as unknown as Record<string, unknown>) : undefined
  ];
  for (const source of headerSources) {
    const explicit =
      extractHeaderValue(source, 'x-routecodex-client-tmux-session-id')
      || extractHeaderValue(source, 'x-rcc-client-tmux-session-id')
      || extractHeaderValue(source, 'x-routecodex-tmux-session-id')
      || extractHeaderValue(source, 'x-rcc-tmux-session-id')
      || extractHeaderValue(source, 'x-tmux-session-id');
    if (explicit) {
      return explicit;
    }
    const fromTurnMetadata = extractSessionScopeFromTurnMetadata(
      extractHeaderValue(source, 'x-codex-turn-metadata')
    );
    if (fromTurnMetadata) {
      return fromTurnMetadata;
    }
  }

  const fromApiKeyHeader =
    extractHeaderValue(headers, 'x-routecodex-api-key')
    || extractHeaderValue(headers, 'x-api-key')
    || extractHeaderValue(headers, 'x-routecodex-apikey')
    || extractHeaderValue(headers, 'api-key')
    || extractHeaderValue(headers, 'apikey');
  const fromApiKey = extractSessionClientScopeIdFromApiKey(fromApiKeyHeader);
  if (fromApiKey) {
    return fromApiKey;
  }

  const authorization = extractHeaderValue(headers, 'authorization');
  if (authorization) {
    const match = authorization.match(/^(?:Bearer|ApiKey)\s+(.+)$/i);
    const fromAuth = extractSessionClientScopeIdFromApiKey(match ? String(match[1]) : authorization);
    if (fromAuth) {
      return fromAuth;
    }
  }

  return undefined;
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

function extractRequestSessionIdFromHeaders(
  headers: Record<string, unknown> | undefined,
  clientHeaders?: Record<string, string>
): string | undefined {
  const sources: Array<Record<string, unknown> | undefined> = [
    headers,
    clientHeaders ? (clientHeaders as unknown as Record<string, unknown>) : undefined
  ];
  for (const source of sources) {
    const sessionId =
      extractHeaderValue(source, 'session_id')
      || extractHeaderValue(source, 'session-id')
      || extractHeaderValue(source, 'x-session-id')
      || extractHeaderValue(source, 'x-routecodex-session-id')
      || extractHeaderValue(source, 'x-rcc-session-id');
    if (sessionId) {
      return sessionId;
    }
  }
  return undefined;
}

function extractRequestConversationIdFromHeaders(
  headers: Record<string, unknown> | undefined,
  clientHeaders?: Record<string, string>
): string | undefined {
  const sources: Array<Record<string, unknown> | undefined> = [
    headers,
    clientHeaders ? (clientHeaders as unknown as Record<string, unknown>) : undefined
  ];
  for (const source of sources) {
    const conversationId =
      extractHeaderValue(source, 'conversation_id')
      || extractHeaderValue(source, 'conversation-id')
      || extractHeaderValue(source, 'x-conversation-id')
      || extractHeaderValue(source, 'x-routecodex-conversation-id');
    if (conversationId) {
      return conversationId;
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
  } catch (decodeError) {
    logExecutorMetadataNonBlocking('extractWorkdirFromTurnMetadata.decodeURIComponent', decodeError);
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
    } catch (base64DecodeError) {
      logExecutorMetadataNonBlocking('extractWorkdirFromTurnMetadata.base64Decode', base64DecodeError);
    }
  }

  for (const candidate of candidates) {
    const normalizedCandidate = candidate.trim();
    if (!normalizedCandidate.startsWith('{') && !normalizedCandidate.startsWith('[')) {
      continue;
    }
    try {
      const parsed = JSON.parse(normalizedCandidate) as Record<string, unknown>;
      const fromJson = extractWorkdirFromTurnMetadataObject(parsed);
      if (fromJson) {
        return fromJson;
      }
    } catch {
      // Encoded turn metadata can include non-JSON candidates before decode/base64 expansion.
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
    } catch (urlParamsError) {
      logExecutorMetadataNonBlocking('extractWorkdirFromTurnMetadata.urlSearchParams', urlParamsError);
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

function extractSessionScopeFromTurnMetadata(rawTurnMetadata: string | undefined): string | undefined {
  if (!rawTurnMetadata) {
    return undefined;
  }
  const candidates = expandTurnMetadataCandidates(rawTurnMetadata);
  for (const candidate of candidates) {
    const normalizedCandidate = candidate.trim();
    if (!normalizedCandidate.startsWith('{') && !normalizedCandidate.startsWith('[')) {
      continue;
    }
    try {
      const parsed = JSON.parse(normalizedCandidate) as Record<string, unknown>;
      const fromJson = extractSessionScopeFromTurnMetadataObject(parsed);
      if (fromJson) {
        return fromJson;
      }
    } catch {
      // Encoded turn metadata can include non-JSON candidates before decode/base64 expansion.
    }

    try {
      const params = new URLSearchParams(candidate);
      const fromParams =
        (params.get('sessionId') || '').trim()
        || (params.get('session_id') || '').trim()
        || (params.get('tmux_session') || '').trim()
        || (params.get('tmuxSession') || '').trim()
        || (params.get('tmuxSessionId') || '').trim()
        || (params.get('tmux_session_id') || '').trim();
      if (fromParams) {
        return fromParams;
      }
    } catch (urlParamsError) {
      logExecutorMetadataNonBlocking('extractSessionScopeFromTurnMetadata.urlSearchParams', urlParamsError);
    }
  }
  return undefined;
}

function expandTurnMetadataCandidates(rawTurnMetadata: string): string[] {
  const candidates = [rawTurnMetadata];
  try {
    candidates.push(decodeURIComponent(rawTurnMetadata));
  } catch (decodeError) {
    logExecutorMetadataNonBlocking('expandTurnMetadataCandidates.decodeURIComponent', decodeError);
  }
  for (const candidate of [...candidates]) {
    const normalized = candidate.trim();
    if (!normalized || !/^[A-Za-z0-9+/=_-]+$/.test(normalized) || normalized.length < 12) {
      continue;
    }
    try {
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
      const decoded = Buffer.from(padded, 'base64').toString('utf8').trim();
      if (decoded) {
        candidates.push(decoded);
      }
    } catch (base64DecodeError) {
      logExecutorMetadataNonBlocking('expandTurnMetadataCandidates.base64Decode', base64DecodeError);
    }
  }
  return candidates;
}

function extractSessionScopeFromTurnMetadataObject(parsed: Record<string, unknown>): string | undefined {
  const direct =
    normalizeToken(parsed.sessionId)
    || normalizeToken(parsed.session_id)
    || normalizeToken(parsed.clientTmuxSessionId)
    || normalizeToken(parsed.client_tmux_session_id)
    || normalizeToken(parsed.rccSessionClientTmuxSessionId)
    || normalizeToken(parsed.rcc_session_client_tmux_session_id)
    || normalizeToken(parsed.tmux_session)
    || normalizeToken(parsed.tmuxSession)
    || normalizeToken(parsed.tmuxSessionId)
    || normalizeToken(parsed.tmux_session_id);
  if (direct) {
    return direct;
  }
  const scope = parsed.scope && typeof parsed.scope === 'object' && !Array.isArray(parsed.scope)
    ? parsed.scope as Record<string, unknown>
    : undefined;
  if (scope) {
    const scoped =
      normalizeToken(scope.sessionId)
      || normalizeToken(scope.session_id)
      || normalizeToken(scope.clientTmuxSessionId)
      || normalizeToken(scope.client_tmux_session_id)
      || normalizeToken(scope.rccSessionClientTmuxSessionId)
      || normalizeToken(scope.rcc_session_client_tmux_session_id)
      || normalizeToken(scope.tmux_session)
      || normalizeToken(scope.tmuxSession)
      || normalizeToken(scope.tmuxSessionId)
      || normalizeToken(scope.tmux_session_id);
    if (scoped) {
      return scoped;
    }
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

function normalizeSessionIdPart(value: unknown): string | undefined {
  const normalized = normalizeToken(value);
  if (!normalized) {
    return undefined;
  }
  return normalized.replace(/[^A-Za-z0-9._:-]+/g, '_').replace(/^_+|_+$/g, '') || undefined;
}

function buildSyntheticLogSessionId(args: {
  explicitSessionId?: string;
  explicitConversationId?: string;
  clientDaemonId?: string;
  sessionScopeId?: string;
  workdir?: string;
  clientType?: string;
}): string | undefined {
  const explicit = normalizeToken(args.explicitSessionId);
  if (explicit) {
    return explicit;
  }
  const conversation = normalizeToken(args.explicitConversationId);
  if (conversation) {
    return conversation;
  }
  const parts = [
    normalizeSessionIdPart(args.clientType),
    normalizeSessionIdPart(args.clientDaemonId),
    normalizeSessionIdPart(args.sessionScopeId),
    normalizeSessionIdPart(args.workdir)
  ].filter((part): part is string => Boolean(part));
  if (parts.length === 0) {
    return undefined;
  }
  return `${SYNTHETIC_SESSION_PREFIX}:${parts.join(':')}`;
}

function resolveEntryPortCandidate(
  portContext: Record<string, unknown> | undefined,
  userMeta: Record<string, unknown>,
  bodyMeta: Record<string, unknown>
): number | undefined {
  return typeof portContext?.matchedPort === 'number' && Number.isFinite(portContext.matchedPort)
    ? Math.floor(portContext.matchedPort)
    : typeof portContext?.localPort === 'number' && Number.isFinite(portContext.localPort)
      ? Math.floor(portContext.localPort)
      : typeof portContext?.entryPort === 'number' && Number.isFinite(portContext.entryPort)
        ? Math.floor(portContext.entryPort)
        : typeof userMeta.matchedPort === 'number' && Number.isFinite(userMeta.matchedPort)
          ? Math.floor(userMeta.matchedPort)
          : typeof userMeta.localPort === 'number' && Number.isFinite(userMeta.localPort)
            ? Math.floor(userMeta.localPort)
            : typeof userMeta.entryPort === 'number' && Number.isFinite(userMeta.entryPort)
              ? Math.floor(userMeta.entryPort)
              : typeof bodyMeta.matchedPort === 'number' && Number.isFinite(bodyMeta.matchedPort)
                ? Math.floor(bodyMeta.matchedPort)
                : typeof bodyMeta.localPort === 'number' && Number.isFinite(bodyMeta.localPort)
                  ? Math.floor(bodyMeta.localPort)
                  : typeof bodyMeta.entryPort === 'number' && Number.isFinite(bodyMeta.entryPort)
                    ? Math.floor(bodyMeta.entryPort)
                    : undefined;
}

function resolvePortContext(
  userMeta: Record<string, unknown>,
  bodyMeta: Record<string, unknown>,
  explicitPortContext?: Record<string, unknown> | null
): Record<string, unknown> | undefined {
  if (explicitPortContext && Object.keys(explicitPortContext).length > 0) {
    return explicitPortContext;
  }
  const userPortContext = asRecord(userMeta.portContext);
  if (Object.keys(userPortContext).length > 0) {
    return userPortContext;
  }
  const bodyPortContext = asRecord(bodyMeta.portContext);
  return Object.keys(bodyPortContext).length > 0 ? bodyPortContext : undefined;
}

export function buildInboundLogSessionContext(input: InboundLogSessionContextInput): Record<string, unknown> {
  const userMeta = asRecord(input.metadata);
  const bodyMeta = asRecord(input.bodyMetadata);
  const clientMetadata = asRecord(
    bodyMeta.client_metadata
    ?? bodyMeta.clientMetadata
    ?? userMeta.client_metadata
    ?? userMeta.clientMetadata
  );
  const headers = asRecord(input.headers);
  const normalizedClientHeaders =
    cloneClientHeaders((userMeta as { clientHeaders?: unknown }).clientHeaders)
    || cloneClientHeaders((headers?.['clientHeaders'] as Record<string, unknown> | undefined) ?? undefined);
  const inboundUserAgent = extractHeaderValue(headers, 'user-agent');
  const inboundOriginator = extractHeaderValue(headers, 'originator');
  const resolvedUserAgent =
    typeof userMeta.userAgent === 'string' && userMeta.userAgent.trim()
      ? userMeta.userAgent.trim()
      : inboundUserAgent;
  const resolvedOriginator =
    typeof userMeta.clientOriginator === 'string' && userMeta.clientOriginator.trim()
      ? userMeta.clientOriginator.trim()
      : inboundOriginator;
  const requestHeaderSessionId = extractRequestSessionIdFromHeaders(headers, normalizedClientHeaders);
  const requestHeaderConversationId = extractRequestConversationIdFromHeaders(headers, normalizedClientHeaders);
  const resolvedSessionDaemonId = extractSessionDaemonId(userMeta, headers);
  const inferredClientType = inferSessionClientType({
    ...userMeta,
    ...(resolvedUserAgent ? { userAgent: resolvedUserAgent } : {}),
    ...(resolvedOriginator ? { clientOriginator: resolvedOriginator } : {})
  });
  const resolvedWorkdir = extractWorkdir(userMeta, bodyMeta, headers, normalizedClientHeaders);
  const resolvedTmuxSessionId = extractSessionScopeId(userMeta, headers, normalizedClientHeaders);
  const requestTruthSource: Record<string, unknown> = {
    ...clientMetadata,
    ...bodyMeta,
    ...userMeta
  };
  if (requestHeaderSessionId) {
    requestTruthSource.sessionId = requestHeaderSessionId;
    if (!requestTruthSource.conversationId) {
      requestTruthSource.conversationId = requestHeaderSessionId;
    }
  }
  if (requestHeaderConversationId) {
    requestTruthSource.conversationId = requestHeaderConversationId;
  }
  const extractedSessionIdentifiers = extractSessionIdentifiersFromMetadata(requestTruthSource);
  const explicitSessionId = normalizeToken(extractedSessionIdentifiers.sessionId);
  const explicitConversationId = normalizeToken(extractedSessionIdentifiers.conversationId);
  const logSessionColorKey = buildSyntheticLogSessionId({
    explicitSessionId,
    explicitConversationId,
    clientDaemonId: resolvedSessionDaemonId,
    sessionScopeId: resolvedTmuxSessionId,
    workdir: resolvedWorkdir,
    clientType: inferredClientType
  });
  const requestSessionId = logSessionColorKey;
  const requestConversationId = explicitConversationId || requestSessionId;
  return {
    ...(requestSessionId ? { sessionId: requestSessionId } : {}),
    ...(requestConversationId ? { conversationId: requestConversationId } : {}),
    ...(logSessionColorKey ? { logSessionColorKey } : {}),
    ...(resolvedSessionDaemonId
      ? {
          clientDaemonId: resolvedSessionDaemonId,
          sessionDaemonId: resolvedSessionDaemonId,
          sessionClientDaemonId: resolvedSessionDaemonId
        }
      : {}),
    ...(resolvedTmuxSessionId
      ? {
          clientTmuxSessionId: resolvedTmuxSessionId,
          tmuxSessionId: resolvedTmuxSessionId
        }
      : {}),
    ...(resolvedWorkdir
      ? {
          clientWorkdir: resolvedWorkdir,
          workdir: resolvedWorkdir,
          cwd: resolvedWorkdir
        }
      : {}),
    ...(inferredClientType
      ? {
          sessionClientType: inferredClientType,
          clientType: inferredClientType
        }
      : {})
  };
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
  tmuxSource?: string;
}): void {
  console.log(
    `[session-scope][metadata] requestId=${args.requestId || 'n/a'} endpoint=${args.entryEndpoint || 'n/a'} ` +
    `daemon=${args.resolvedSessionDaemonId || 'none'} tmux=${args.resolvedTmuxSessionId || 'none'} ` +
    `workdir=${args.resolvedWorkdir || 'none'} ` +
    `originator=${args.originator || 'n/a'} ua=${args.userAgent || 'n/a'} ` +
    `tmuxSource=${args.tmuxSource || 'none'}`
  );
}

export function buildRequestMetadata(input: PipelineExecutionInput): Record<string, unknown> {
  const userMeta = asRecord(input.metadata);
  const bodyRecord = asRecord(input.body);
  const bodyMeta = asRecord(bodyRecord.metadata);
  const clientMetadata = asRecord(
    bodyRecord.client_metadata
    ?? bodyRecord.clientMetadata
    ?? bodyMeta.client_metadata
    ?? bodyMeta.clientMetadata
    ?? userMeta.client_metadata
    ?? userMeta.clientMetadata
  );
  const headers = asRecord(input.headers);
  const portContext = resolvePortContext(userMeta, bodyMeta);
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
  const requestHeaderSessionId = extractRequestSessionIdFromHeaders(headers, normalizedClientHeaders);
  const requestHeaderConversationId = extractRequestConversationIdFromHeaders(headers, normalizedClientHeaders);
  const routeHint = extractRouteHint(input);
  const processMode = (userMeta.processMode as string) || 'chat';
  let resolvedSessionDaemonId = extractSessionDaemonId(userMeta, headers);
  const inferredClientType = inferSessionClientType({
    ...userMeta,
    ...(resolvedUserAgent ? { userAgent: resolvedUserAgent } : {}),
    ...(resolvedOriginator ? { clientOriginator: resolvedOriginator } : {})
  });
  const directWorkdir = extractWorkdir(userMeta, bodyMeta, headers, normalizedClientHeaders);
  const resolvedTmuxTarget = undefined;
  const resolvedWorkdir = directWorkdir;
  const resolvedTmuxSessionId = extractSessionScopeId(userMeta, headers, normalizedClientHeaders);
  const tmuxSource = resolvedTmuxSessionId ? 'inbound' : 'none';
  const inboundLogSessionContext = buildInboundLogSessionContext({
    entryEndpoint: input.entryEndpoint,
    headers,
    bodyMetadata: {
      ...bodyMeta,
      ...(Object.keys(clientMetadata).length > 0 ? { client_metadata: clientMetadata } : {})
    },
    metadata: userMeta,
    portContext
  });
  const metadata: Record<string, unknown> = {
    ...userMeta,
    ...inboundLogSessionContext,
    entryEndpoint: input.entryEndpoint,
    processMode,
    direction: 'request',
    stage: 'inbound',
    __raw_request_body: Object.prototype.hasOwnProperty.call(userMeta, '__raw_request_body')
      ? userMeta.__raw_request_body
      : input.body,
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
          workdir: resolvedWorkdir,
          cwd: resolvedWorkdir
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
  };
  delete metadata.routeHint;
  delete metadata.responsesRequestContext;
  if (metadata.__rt && typeof metadata.__rt === 'object' && !Array.isArray(metadata.__rt)) {
    const rt = { ...(metadata.__rt as Record<string, unknown>) };
    delete rt.responsesRequestContext;
    metadata.__rt = rt;
  }

  if (normalizedClientHeaders) {
    metadata.clientHeaders = normalizedClientHeaders;
  }

  const center = MetadataCenter.attach(metadata);
  const initialRequestTruth = center.readRequestTruth();
  if (input.requestId && !initialRequestTruth.requestId) {
      writeMetadataCenterSlot({
        target: metadata,
        family: 'request_truth',
        key: 'requestId',
        value: input.requestId,
        writer: BUILD_REQUEST_METADATA_WRITER,
        reason: 'request entry request id'
      });
  }
  if (input.entryEndpoint && !initialRequestTruth.entryEndpoint) {
    writeMetadataCenterSlot({
      target: metadata,
      family: 'request_truth',
      key: 'entryEndpoint',
      value: input.entryEndpoint,
      writer: BUILD_REQUEST_METADATA_WRITER,
      reason: 'request entry endpoint'
    });
  }
  if (typeof metadata.clientRequestId === 'string' && metadata.clientRequestId.trim() && !initialRequestTruth.clientRequestId) {
    writeMetadataCenterSlot({
      target: metadata,
      family: 'request_truth',
      key: 'clientRequestId',
      value: metadata.clientRequestId.trim(),
      writer: BUILD_REQUEST_METADATA_WRITER,
      reason: 'request entry client request id'
    });
  }
  const entryPortCandidate = resolveEntryPortCandidate(portContext, userMeta, bodyMeta);
  if (typeof entryPortCandidate === 'number') {
    const entryPortScope = String(entryPortCandidate);
    const existingPortScope = center.readRequestTruth().portScope;
    if (existingPortScope && existingPortScope !== entryPortScope) {
      throw new Error(
        `MetadataCenter request_truth.portScope conflict: existing=${existingPortScope} incoming=${entryPortScope}`
      );
    }
    if (!existingPortScope) {
      writeMetadataCenterSlot({
        target: metadata,
        family: 'request_truth',
        key: 'portScope',
        value: entryPortScope,
        writer: BUILD_REQUEST_METADATA_WRITER,
        reason: 'request entry port scope'
      });
    }
    metadata.portScope = entryPortScope;
  }
  if (routeHint) {
    writeMetadataCenterSlot({
      target: metadata,
      family: 'runtime_control',
      key: 'routeHint',
      value: routeHint,
      writer: BUILD_REQUEST_METADATA_WRITER,
      reason: 'request route hint'
    });
  }
  const requestTruthSource: Record<string, unknown> = {
    ...clientMetadata,
    ...bodyMeta,
    ...metadata
  };
  if (requestHeaderSessionId) {
    requestTruthSource.sessionId = requestHeaderSessionId;
    if (!requestTruthSource.conversationId) {
      requestTruthSource.conversationId = requestHeaderSessionId;
    }
  }
  if (requestHeaderConversationId) {
    requestTruthSource.conversationId = requestHeaderConversationId;
  }
  delete requestTruthSource.responsesRequestContext;
  if (requestTruthSource.__rt && typeof requestTruthSource.__rt === 'object' && !Array.isArray(requestTruthSource.__rt)) {
    const rt = { ...(requestTruthSource.__rt as Record<string, unknown>) };
    delete rt.responsesRequestContext;
    requestTruthSource.__rt = rt;
  }
  const extractedSessionIdentifiers = extractSessionIdentifiersFromMetadata(requestTruthSource);
  const existingSessionId = typeof extractedSessionIdentifiers.sessionId === 'string' && extractedSessionIdentifiers.sessionId.trim()
    ? extractedSessionIdentifiers.sessionId.trim()
    : undefined;
  const existingConversationId = typeof extractedSessionIdentifiers.conversationId === 'string' && extractedSessionIdentifiers.conversationId.trim()
    ? extractedSessionIdentifiers.conversationId.trim()
    : undefined;
  const sessionIdentifiers = {
    ...(existingSessionId ? { sessionId: existingSessionId } : {}),
    ...(existingConversationId ? { conversationId: existingConversationId } : {})
  };
  const currentRequestTruth = center.readRequestTruth();
  if (sessionIdentifiers.sessionId && !currentRequestTruth.sessionId) {
    writeMetadataCenterSlot({
      target: metadata,
      family: 'request_truth',
      key: 'sessionId',
      value: sessionIdentifiers.sessionId,
      writer: BUILD_REQUEST_METADATA_WRITER,
      reason: 'request entry session identity'
    });
  }
  if (sessionIdentifiers.sessionId) {
    metadata.sessionId = sessionIdentifiers.sessionId;
  }
  if (sessionIdentifiers.conversationId && !currentRequestTruth.conversationId) {
    writeMetadataCenterSlot({
      target: metadata,
      family: 'request_truth',
      key: 'conversationId',
      value: sessionIdentifiers.conversationId,
      writer: BUILD_REQUEST_METADATA_WRITER,
      reason: 'request entry conversation identity'
    });
  }
  if (sessionIdentifiers.conversationId) {
    metadata.conversationId = sessionIdentifiers.conversationId;
  }
  const responsesResumeSource =
    (bodyMeta.responsesResume && typeof bodyMeta.responsesResume === 'object' && !Array.isArray(bodyMeta.responsesResume)
      ? bodyMeta.responsesResume as Record<string, unknown>
      : undefined)
    ?? (userMeta.responsesResume && typeof userMeta.responsesResume === 'object' && !Array.isArray(userMeta.responsesResume)
      ? userMeta.responsesResume as Record<string, unknown>
      : undefined)
    ?? (metadata.responsesResume && typeof metadata.responsesResume === 'object' && !Array.isArray(metadata.responsesResume)
      ? metadata.responsesResume as Record<string, unknown>
      : undefined)
    ?? (center.readContinuationContext().responsesResume && typeof center.readContinuationContext().responsesResume === 'object' && !Array.isArray(center.readContinuationContext().responsesResume)
      ? center.readContinuationContext().responsesResume as Record<string, unknown>
      : undefined);
  if (responsesResumeSource) {
    writeMetadataCenterSlot({
      target: metadata,
      family: 'continuation_context',
      key: 'responsesResume',
      value: responsesResumeSource,
      writer: BUILD_REQUEST_METADATA_INBOUND_WRITER,
      reason: 'responses resume request truth'
    });
    metadata.responsesResume = responsesResumeSource;
    const runtimeControl = center.readRuntimeControl();
    const responsesResumeContinuationOwner =
      typeof responsesResumeSource.continuationOwner === 'string' && responsesResumeSource.continuationOwner.trim()
        ? responsesResumeSource.continuationOwner.trim()
        : undefined;
    const projectedRouteHint =
      typeof runtimeControl.routeHint === 'string' && runtimeControl.routeHint.trim()
        ? runtimeControl.routeHint.trim()
        : typeof responsesResumeSource.routeHint === 'string' && responsesResumeSource.routeHint.trim()
          ? responsesResumeSource.routeHint.trim()
          : undefined;
    if (projectedRouteHint && !runtimeControl.routeHint) {
      writeMetadataCenterSlot({
        target: metadata,
        family: 'runtime_control',
        key: 'routeHint',
        value: projectedRouteHint,
        writer: BUILD_REQUEST_METADATA_INBOUND_WRITER,
        reason: 'responses resume route hint'
      });
    }
    const projectedRetryProviderKey =
      typeof runtimeControl.retryProviderKey === 'string' && runtimeControl.retryProviderKey.trim()
        ? runtimeControl.retryProviderKey.trim()
        : responsesResumeContinuationOwner !== 'relay'
          && typeof responsesResumeSource.providerKey === 'string' && responsesResumeSource.providerKey.trim()
          ? responsesResumeSource.providerKey.trim()
          : undefined;
    if (projectedRetryProviderKey && !runtimeControl.retryProviderKey) {
      writeMetadataCenterSlot({
        target: metadata,
        family: 'runtime_control',
        key: 'retryProviderKey',
        value: projectedRetryProviderKey,
        writer: BUILD_REQUEST_METADATA_INBOUND_WRITER,
        reason: 'responses resume retry provider pin'
      });
    }
  }
  if (hasStoplessDirectiveInRequestPayload(input.body)) {
    writeMetadataCenterSlot({
      target: metadata,
      family: 'runtime_control',
      key: 'stopMessageEnabled',
      value: true,
      writer: BUILD_REQUEST_METADATA_WRITER,
      reason: 'request stopless directive'
    });
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
      tmuxSource
    });
  }

  projectNativeTopLevelRuntimeControl(metadata, readRuntimeControlProjection(metadata));
  return metadata;
}

function projectNativeTopLevelRuntimeControl(
  target: Record<string, unknown>,
  runtimeControl: ReturnType<typeof readRuntimeControlProjection>
): void {
  const routeHint =
    typeof runtimeControl.routeHint === 'string' && runtimeControl.routeHint.trim()
      ? runtimeControl.routeHint.trim()
      : undefined;
  if (shouldProjectRouteHintToTopLevel(routeHint)) {
    target.routeHint = routeHint;
  }
}

function shouldProjectRouteHintToTopLevel(routeHint: string | undefined): boolean {
  if (!routeHint) {
    return false;
  }
  return routeHint === 'longcontext' || routeHint === 'multimodal';
}

export function decorateMetadataForAttempt(
  base: Record<string, unknown>,
  attempt: number,
  excludedProviderKeys: Set<string>
): Record<string, unknown> {
  const clone = cloneMetadata(base);
  const metadataCenter = MetadataCenter.read(base);
  if (metadataCenter) {
    MetadataCenter.bind(clone, metadataCenter);
    bindMetadataCenterRustMirror(base, clone);
  }
  preserveLiveClientAbortCarriers({ source: base, target: clone });
  clone.retryAttempt = attempt;
  delete clone.__routecodexRetryProviderKey;
  if (excludedProviderKeys.size > 0) {
    if (attempt > 1) {
      clone.excludedProviderKeys = Array.from(excludedProviderKeys);
    } else {
      delete clone.excludedProviderKeys;
    }
  } else if (clone.excludedProviderKeys) {
    delete clone.excludedProviderKeys;
  }
  if (attempt > 1) {
    const rt = clone.__rt && typeof clone.__rt === 'object' && !Array.isArray(clone.__rt)
      ? { ...(clone.__rt as Record<string, unknown>) }
      : undefined;
    if (rt && Object.prototype.hasOwnProperty.call(rt, 'preselectedRoute')) {
      delete rt.preselectedRoute;
      clone.__rt = rt;
    }
    releaseMetadataCenterSlot({
      target: clone,
      family: 'runtime_control',
      key: 'preselectedRoute',
      writer: ATTEMPT_METADATA_RUNTIME_CONTROL_RELEASE_WRITER,
      reason: 'preselected route is single-use and must not pin provider retry attempts'
    });
    releaseMetadataCenterSlot({
      target: clone,
      family: 'runtime_control',
      key: 'retryProviderKey',
      writer: ATTEMPT_METADATA_RUNTIME_CONTROL_RELEASE_WRITER,
      reason: 'retry provider pin is single-use and must not force provider retry attempts'
    });
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
  const metadataRouteHint = readRuntimeControlProjection(asRecord(input.metadata)).routeHint;
  if (metadataRouteHint) {
    return metadataRouteHint;
  }
  const bodyMetadata = asRecord(asRecord(input.body).metadata);
  const bodyHasResponsesResume =
    isRecord(bodyMetadata?.responsesResume)
    || isRecord(bodyMetadata?.responsesResumeContext)
    || typeof bodyMetadata?.previous_response_id === 'string'
    || typeof bodyMetadata?.response_id === 'string';
  const servertoolCliRouteHint = extractServertoolCliResultRouteHint(input);
  if (servertoolCliRouteHint) {
    return servertoolCliRouteHint;
  }
  if (bodyHasResponsesResume) {
    return undefined;
  }
  const bodyRouteHint = normalizeToken(bodyMetadata?.routeHint);
  if (bodyRouteHint) {
    return bodyRouteHint;
  }
  return undefined;
}

function extractServertoolCliResultRouteHint(input: PipelineExecutionInput): string | undefined {
  if (!requestMayContainToolOutput(input.body)) {
    return undefined;
  }
  return extractServertoolCliResultRouteHintFromRequestNative({
    adapterContext: {
      __raw_request_body: input.body
    },
    runtimeMetadata: input.metadata
  });
}

function requestMayContainToolOutput(value: unknown): boolean {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' && (
      text.includes('"tool_outputs"')
      || text.includes('"function_call_output"')
      || text.includes('"tool_result"')
      || text.includes('"tool_message"')
    );
  } catch {
    return false;
  }
}

function cloneMetadata(source: Record<string, unknown>): Record<string, unknown> {
  return { ...source };
}
