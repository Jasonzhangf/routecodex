import type { PipelineExecutionInput } from '../../handlers/types.js';
// feature_id: hub.metadata_center_request_capture
import { asRecord } from './provider-utils.js';
import {
  extractSessionIdentifiersFromMetadata
} from '../../../modules/llmswitch/bridge.js';
import { MetadataCenter } from './metadata-center/metadata-center.js';
import {
  bindMetadataCenterRustMirror,
  writeMetadataCenterSlot
} from './metadata-center/dualwrite-api.js';
import { extractSessionClientDaemonIdFromApiKey } from '../../../utils/session-client-token.js';
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
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const fromJson = extractWorkdirFromTurnMetadataObject(parsed);
      if (fromJson) {
        return fromJson;
      }
    } catch (jsonParseError) {
      logExecutorMetadataNonBlocking('extractWorkdirFromTurnMetadata.jsonParse', jsonParseError);
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
  const bodyMeta = asRecord(asRecord(input.body).metadata);
  const headers = asRecord(input.headers);
  const portContext = asRecord(userMeta.portContext) ?? asRecord(bodyMeta.portContext);
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
  const inferredClientType = inferSessionClientType(userMeta);
  const directWorkdir = extractWorkdir(userMeta, bodyMeta, headers, normalizedClientHeaders);
  const resolvedTmuxTarget = undefined;
  const resolvedWorkdir = directWorkdir;
  const resolvedTmuxSessionId = undefined;
  const tmuxSource = 'none';
  const metadata: Record<string, unknown> = {
    ...userMeta,
    entryEndpoint: input.entryEndpoint,
    processMode,
    direction: 'request',
    stage: 'inbound',
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
  const entryPortCandidate =
    typeof portContext?.matchedPort === 'number' && Number.isFinite(portContext.matchedPort)
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
  const sessionIdentifiers = extractSessionIdentifiersFromMetadata(requestTruthSource);
  const currentRequestTruth = center.readRequestTruth();
  if (sessionIdentifiers.sessionId && !currentRequestTruth.sessionId) {
    writeMetadataCenterSlot({
      target: metadata,
      family: 'request_truth',
      key: 'sessionId',
      value: sessionIdentifiers.sessionId,
      writer: BUILD_REQUEST_METADATA_WRITER
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
      writer: BUILD_REQUEST_METADATA_WRITER
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
  if (excludedProviderKeys.size > 0) {
    clone.excludedProviderKeys = Array.from(excludedProviderKeys);
    delete clone.__routecodexPreselectedRoute;
  } else if (clone.excludedProviderKeys) {
    delete clone.excludedProviderKeys;
  }
  if (attempt > 1) {
    delete clone.__routecodexPreselectedRoute;
    const rt = clone.__rt && typeof clone.__rt === 'object' && !Array.isArray(clone.__rt)
      ? { ...(clone.__rt as Record<string, unknown>) }
      : undefined;
    if (rt && Object.prototype.hasOwnProperty.call(rt, 'preselectedRoute')) {
      delete rt.preselectedRoute;
      clone.__rt = rt;
    }
    MetadataCenter.read(clone)?.releaseRuntimeControl(
      'preselectedRoute',
      ATTEMPT_METADATA_RUNTIME_CONTROL_RELEASE_WRITER,
      'preselected route is single-use and must not pin provider retry attempts'
    );
    MetadataCenter.read(clone)?.releaseRuntimeControl(
      'providerProtocol',
      ATTEMPT_METADATA_RUNTIME_CONTROL_RELEASE_WRITER,
      'provider protocol is attempt-scoped and must be rebound after provider retry selection'
    );
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
  return source;
}
