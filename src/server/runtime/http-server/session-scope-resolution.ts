import { extractSessionClientScopeIdFromApiKey } from '../../../utils/session-client-token.js';

const SESSION_SCOPE_NON_BLOCKING_LOG_THROTTLE_MS = 60_000;
const sessionScopeNonBlockingLogState = new Map<string, number>();

type SessionScopeResolutionArgs = {
  userMeta: Record<string, unknown>;
  bodyMeta: Record<string, unknown>;
  headers?: Record<string, unknown>;
  clientHeaders?: Record<string, string>;
  daemonId?: string;
  resolveTmuxSessionIdFromDaemon?: (daemonId: string | undefined) => string | undefined;
  resolveTmuxSessionIdFromBinding?: (sessionScopeId: string) => string | undefined;
  isTmuxSessionAlive?: (tmuxSessionId: string) => boolean;
};

export type TmuxSessionResolution = {
  tmuxSessionId?: string;
  source: 'metadata' | 'body_metadata' | 'headers_or_api_key' | 'registry_by_daemon' | 'registry_by_binding' | 'none';
};

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function logSessionScopeResolutionNonBlockingError(
  stage: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  const now = Date.now();
  const last = sessionScopeNonBlockingLogState.get(stage) ?? 0;
  if (now - last < SESSION_SCOPE_NON_BLOCKING_LOG_THROTTLE_MS) {
    return;
  }
  sessionScopeNonBlockingLogState.set(stage, now);
  try {
    const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[session-scope-resolution] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`);
  } catch {
    // never throw from non-blocking logging
  }
}

function readToken(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
    if (Array.isArray(value) && value.length > 0) {
      return String(value[0]).trim() || undefined;
    }
    return undefined;
  }
  return undefined;
}

function extractTmuxSessionIdFromTurnMetadata(rawValue: string | undefined): string | undefined {
  if (!rawValue) {
    return undefined;
  }
  const normalizeTmuxToken = (value: unknown): string | undefined => {
    const token = readToken(value);
    if (!token) {
      return undefined;
    }
    if (!/^[a-zA-Z0-9._:-]+$/.test(token)) {
      return undefined;
    }
    return token;
  };

  const parseFromObject = (root: unknown): string | undefined => {
    if (!root || typeof root !== 'object') {
      return undefined;
    }
    const queue: unknown[] = [root];
    const visited = new Set<object>();
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || typeof current !== 'object') {
        continue;
      }
      if (visited.has(current as object)) {
        continue;
      }
      visited.add(current as object);

      if (Array.isArray(current)) {
        for (const value of current) {
          if (value && typeof value === 'object') {
            queue.push(value);
          }
        }
        continue;
      }

      const record = current as Record<string, unknown>;
      const directTmux =
        normalizeTmuxToken(record.tmuxSessionId)
        || normalizeTmuxToken(record.tmux_session_id)
        || normalizeTmuxToken(record.tmuxSession)
        || normalizeTmuxToken(record.tmux_session)
        || normalizeTmuxToken(record.rccTmuxSessionId)
        || normalizeTmuxToken(record.rcc_tmux_session_id)
        || normalizeTmuxToken(record.clientTmuxSessionId)
        || normalizeTmuxToken(record.client_tmux_session_id)
        || normalizeTmuxToken(record.rccSessionClientTmuxSessionId)
        || normalizeTmuxToken(record.rcc_session_client_tmux_session_id);
      if (directTmux) {
        return directTmux;
      }

      for (const [key, value] of Object.entries(record)) {
        if (value && typeof value === 'object') {
          queue.push(value);
          continue;
        }
        if (typeof value !== 'string') {
          continue;
        }
        const normalizedKey = key.trim().toLowerCase();
        if (
          normalizedKey.includes('tmux')
          || normalizedKey === 'rcc_session_client_tmux_session_id'
          || normalizedKey === 'rccsessionclienttmuxsessionid'
        ) {
          const token = normalizeTmuxToken(value);
          if (token) {
            return token;
          }
        }
      }
    }
    return undefined;
  };

  const candidates = [rawValue];
  try {
    candidates.push(decodeURIComponent(rawValue));
  } catch (error: unknown) {
    logSessionScopeResolutionNonBlockingError('extractTmuxSessionIdFromTurnMetadata.decodeURIComponent', error);
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
    } catch (error: unknown) {
      logSessionScopeResolutionNonBlockingError('extractTmuxSessionIdFromTurnMetadata.base64Decode', error);
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const tmux = parseFromObject(parsed);
      if (tmux) {
        return tmux;
      }
    } catch (error: unknown) {
      logSessionScopeResolutionNonBlockingError('extractTmuxSessionIdFromTurnMetadata.parseJson', error);
    }

    try {
      const params = new URLSearchParams(candidate);
      const fromParams =
        normalizeTmuxToken(params.get('tmuxSessionId'))
        || normalizeTmuxToken(params.get('tmux_session_id'))
        || normalizeTmuxToken(params.get('tmuxSession'))
        || normalizeTmuxToken(params.get('tmux_session'))
        || normalizeTmuxToken(params.get('rccTmuxSessionId'))
        || normalizeTmuxToken(params.get('rcc_tmux_session_id'))
        || normalizeTmuxToken(params.get('clientTmuxSessionId'))
        || normalizeTmuxToken(params.get('client_tmux_session_id'))
        || normalizeTmuxToken(params.get('rcc_session_client_tmux_session_id'));
      if (fromParams) {
        return fromParams;
      }
    } catch (error: unknown) {
      logSessionScopeResolutionNonBlockingError('extractTmuxSessionIdFromTurnMetadata.parseUrlSearchParams', error);
    }
  }
  return undefined;
}

function readTmuxFromHeaderSource(source: Record<string, unknown> | undefined): string | undefined {
  if (!source) {
    return undefined;
  }
  const fromTurnMeta = extractTmuxSessionIdFromTurnMetadata(extractHeaderValue(source, 'x-codex-turn-metadata'));
  if (fromTurnMeta) {
    return fromTurnMeta;
  }
  const fromHeader =
    extractHeaderValue(source, 'x-routecodex-client-tmux-session-id')
    || extractHeaderValue(source, 'x-rcc-client-tmux-session-id')
    || extractHeaderValue(source, 'x-routecodex-client-tmuxsession-id')
    || extractHeaderValue(source, 'x-rcc-client-tmuxsession-id')
    || extractHeaderValue(source, 'x-routecodex-clienttmuxsessionid')
    || extractHeaderValue(source, 'x-routecodex-tmux-session-id')
    || extractHeaderValue(source, 'x-rcc-tmux-session-id')
    || extractHeaderValue(source, 'x-tmux-session-id');
  if (fromHeader) {
    return fromHeader;
  }
  const fromApiKeyHeader =
    extractHeaderValue(source, 'x-routecodex-api-key')
    || extractHeaderValue(source, 'x-api-key')
    || extractHeaderValue(source, 'x-routecodex-apikey')
    || extractHeaderValue(source, 'api-key')
    || extractHeaderValue(source, 'apikey');
  const fromApiKey = extractSessionClientScopeIdFromApiKey(fromApiKeyHeader);
  if (fromApiKey) {
    return fromApiKey;
  }
  const authorization = extractHeaderValue(source, 'authorization');
  if (authorization) {
    const match = authorization.match(/^(?:Bearer|ApiKey)\s+(.+)$/i);
    const fromAuth = extractSessionClientScopeIdFromApiKey(match ? String(match[1]) : authorization);
    if (fromAuth) {
      return fromAuth;
    }
  }
  return undefined;
}

function readSessionScopeFromHeaderSource(source: Record<string, unknown> | undefined): string | undefined {
  if (!source) {
    return undefined;
  }
  const fromApiKeyHeader =
    extractHeaderValue(source, 'x-routecodex-api-key')
    || extractHeaderValue(source, 'x-api-key')
    || extractHeaderValue(source, 'x-routecodex-apikey')
    || extractHeaderValue(source, 'api-key')
    || extractHeaderValue(source, 'apikey');
  const fromApiKey = extractSessionClientScopeIdFromApiKey(fromApiKeyHeader);
  if (fromApiKey) {
    return fromApiKey;
  }
  const authorization = extractHeaderValue(source, 'authorization');
  if (authorization) {
    const match = authorization.match(/^(?:Bearer|ApiKey)\s+(.+)$/i);
    const fromAuth = extractSessionClientScopeIdFromApiKey(match ? String(match[1]) : authorization);
    if (fromAuth) {
      return fromAuth;
    }
  }
  return undefined;
}

function collectBindingSessionScopeCandidates(args: SessionScopeResolutionArgs): string[] {
  const candidates: string[] = [];
  const push = (value: unknown): void => {
    const token = readToken(value);
    if (!token) {
      return;
    }
    if (!candidates.includes(token)) {
      candidates.push(token);
    }
  };

  const headerSources: Array<Record<string, unknown> | undefined> = [
    args.headers,
    args.clientHeaders as unknown as Record<string, unknown> | undefined
  ];

  for (const source of headerSources) {
    push(extractHeaderValue(source, 'session_id'));
    push(extractHeaderValue(source, 'session-id'));
    push(extractHeaderValue(source, 'x-session-id'));
    push(extractHeaderValue(source, 'x-routecodex-session-id'));
    push(extractHeaderValue(source, 'x-rcc-session-id'));
    push(extractHeaderValue(source, 'conversation_id'));
    push(extractHeaderValue(source, 'conversation-id'));
    push(extractHeaderValue(source, 'x-conversation-id'));
    push(extractHeaderValue(source, 'x-routecodex-conversation-id'));
    push(readSessionScopeFromHeaderSource(source));
  }

  push(args.userMeta.sessionId);
  push(args.userMeta.session_id);
  push(args.userMeta.conversationId);
  push(args.userMeta.conversation_id);
  push(args.bodyMeta.sessionId);
  push(args.bodyMeta.session_id);
  push(args.bodyMeta.conversationId);
  push(args.bodyMeta.conversation_id);

  if (args.daemonId && readToken(args.daemonId)) {
    push(`sessiond.${readToken(args.daemonId)}`);
  }

  return candidates;
}

function isTmuxCandidateAlive(args: SessionScopeResolutionArgs, tmuxSessionId: string): boolean {
  if (typeof args.isTmuxSessionAlive !== 'function') {
    return true;
  }
  try {
    return args.isTmuxSessionAlive(tmuxSessionId);
  } catch (error: unknown) {
    logSessionScopeResolutionNonBlockingError('isTmuxCandidateAlive', error, { tmuxSessionId });
    return false;
  }
}

function resolveIfAlive(args: SessionScopeResolutionArgs, candidate: string | undefined): string | undefined {
  const token = readToken(candidate);
  if (!token) {
    return undefined;
  }
  return isTmuxCandidateAlive(args, token) ? token : undefined;
}

export function resolveTmuxSessionIdAndSource(args: SessionScopeResolutionArgs): TmuxSessionResolution {
  const tmuxFromHeaders = resolveIfAlive(
    args,
    readTmuxFromHeaderSource(args.headers)
      || readTmuxFromHeaderSource(args.clientHeaders as unknown as Record<string, unknown> | undefined)
  );
  if (tmuxFromHeaders) {
    return { tmuxSessionId: tmuxFromHeaders, source: 'headers_or_api_key' };
  }

  const tmuxFromMeta = resolveIfAlive(args, readToken(args.userMeta.tmuxSessionId) || readToken(args.userMeta.tmux_session_id));
  if (tmuxFromMeta) {
    return { tmuxSessionId: tmuxFromMeta, source: 'metadata' };
  }

  const tmuxFromBody = resolveIfAlive(args, readToken(args.bodyMeta.tmuxSessionId) || readToken(args.bodyMeta.tmux_session_id));
  if (tmuxFromBody) {
    return { tmuxSessionId: tmuxFromBody, source: 'body_metadata' };
  }

  const tmuxFromDaemon = resolveIfAlive(args, readToken(args.resolveTmuxSessionIdFromDaemon?.(args.daemonId)));
  if (tmuxFromDaemon) {
    return { tmuxSessionId: tmuxFromDaemon, source: 'registry_by_daemon' };
  }

  if (typeof args.resolveTmuxSessionIdFromBinding === 'function') {
    const bindingCandidates = collectBindingSessionScopeCandidates(args);
    for (const scope of bindingCandidates) {
      const tmuxFromBinding = resolveIfAlive(args, readToken(args.resolveTmuxSessionIdFromBinding(scope)));
      if (tmuxFromBinding) {
        return { tmuxSessionId: tmuxFromBinding, source: 'registry_by_binding' };
      }
    }
  }

  return { source: 'none' };
}
