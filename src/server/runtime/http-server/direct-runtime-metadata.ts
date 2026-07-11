import { propagatePipelineDryRunControl } from '../../../debug/pipeline-dry-run.js';

const DIRECT_PROVIDER_RUNTIME_METADATA_KEYS = [
  'clientRequestId',
  'providerStreamNoContentTimeoutMs',
  'streamNoContentTimeoutMs',
  'noContentTimeoutMs',
  'providerStreamContentIdleTimeoutMs',
  'streamContentIdleTimeoutMs',
  'contentIdleTimeoutMs',
  'providerStreamHeadersTimeoutMs',
  'streamHeadersTimeoutMs',
  'headersTimeoutMs',
] as const;

const ROUTER_DIRECT_ROUTE_METADATA_PRIMITIVE_KEYS = [
  'requestId',
  'clientRequestId',
  'inputRequestId',
  'groupRequestId',
  'sessionId',
  'session_id',
  'conversationId',
  'conversation_id',
  'logSessionColorKey',
  'clientTmuxSessionId',
  'client_tmux_session_id',
  'tmuxSessionId',
  'tmux_session_id',
  'rccSessionClientTmuxSessionId',
  'rcc_session_client_tmux_session_id',
  'routecodexRoutingPolicyGroup',
  'routecodexLocalPort',
  'entryPort',
  'matchedPort',
  'routecodexPortMode',
  'routecodexPortBinding',
  'estimatedInputTokens',
  'estimatedTokens',
  'estimated_tokens',
  'serverToolRequired',
  '__shadowCompareForcedProviderKey',
  'routerDirectInboundProtocol',
  'routeHint',
] as const;

const ROUTER_DIRECT_RUNTIME_CONTROL_KEYS = [
  'routecodexRoutingPolicyGroup',
  'providerProtocol',
  'routeHint',
  'retryProviderKey',
  'stopMessageEnabled',
  'stopMessageExcludeDirect',
  'sessionDir',
  'rccUserDir',
  'nowMs',
  'serverToolFollowup',
] as const;

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function copyPrimitiveKey(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  const value = source[key];
  if (typeof value === 'boolean') {
    target[key] = value;
    return;
  }
  const text = readNonEmptyString(value);
  if (text) {
    target[key] = text;
    return;
  }
  const numeric = readFiniteNumber(value);
  if (typeof numeric === 'number') {
    target[key] = numeric;
  }
}

function readPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function copyStringArrayKey(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  const values = Array.isArray(source[key])
    ? (source[key] as unknown[])
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim())
    : [];
  if (values.length > 0) {
    target[key] = values;
  }
}

function projectPrimitiveRecord(
  source: Record<string, unknown> | undefined,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (!source) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    copyPrimitiveKey(out, source, key);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function projectRouteMetadataCenterSnapshot(
  snapshot: Record<string, unknown> | undefined,
  flatMetadata: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const requestTruth = projectPrimitiveRecord(readPlainRecord(snapshot?.requestTruth), [
    'requestId',
    'pipelineId',
    'entryEndpoint',
    'sessionId',
    'conversationId',
    'clientRequestId',
    'portScope',
  ]);
  if (requestTruth) {
    out.requestTruth = requestTruth;
  }
  const continuationContextSource = readPlainRecord(snapshot?.continuationContext);
  const continuationContext = projectPrimitiveRecord(continuationContextSource, [
    'previousResponseId',
    'continuationOwner',
  ]);
  const responsesResume = projectPrimitiveRecord(readPlainRecord(continuationContextSource?.responsesResume), [
    'previousResponseId',
    'responseId',
    'requestId',
    'chainId',
    'continuationOwner',
    'continuationScope',
    'stickyScope',
  ]);
  if (continuationContext || responsesResume) {
    out.continuationContext = {
      ...(continuationContext ?? {}),
      ...(responsesResume ? { responsesResume } : {}),
    };
  }
  const runtimeControl = {
    ...(projectPrimitiveRecord(readPlainRecord(snapshot?.runtimeControl), ROUTER_DIRECT_RUNTIME_CONTROL_KEYS) ?? {}),
    ...(projectPrimitiveRecord(readPlainRecord(flatMetadata.__rt), ['sessionDir', 'rccUserDir']) ?? {}),
  };
  if (Object.keys(runtimeControl).length > 0) {
    out.runtimeControl = runtimeControl;
  }
  copyStringArrayKey(out, snapshot ?? {}, 'excludedProviderKeys');
  copyStringArrayKey(out, flatMetadata, 'excludedProviderKeys');
  copyStringArrayKey(out, flatMetadata, 'allowedProviders');
  for (const key of [
    'requestId',
    'sessionId',
    'conversationId',
    'logSessionColorKey',
    'clientTmuxSessionId',
    'client_tmux_session_id',
    'tmuxSessionId',
    'tmux_session_id',
    'rccSessionClientTmuxSessionId',
    'rcc_session_client_tmux_session_id',
  ] as const) {
    const fromRequestTruth = readNonEmptyString(requestTruth?.[key]);
    const fromFlat = readNonEmptyString(flatMetadata[key]);
    const value = fromRequestTruth ?? fromFlat;
    if (value) {
      out[key] = value;
    }
  }
  for (const key of ['routecodexRoutingPolicyGroup', 'routecodexLocalPort', 'routecodexPortMode', 'routecodexPortBinding'] as const) {
    copyPrimitiveKey(out, flatMetadata, key);
  }
  return out;
}

export function buildRouterDirectRouteMetadata(input: {
  metadata?: Record<string, unknown>;
  metadataCenterSnapshot?: Record<string, unknown>;
  requestId?: string;
  entryEndpoint?: string;
}): Record<string, unknown> {
  const source = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
    ? input.metadata
    : {};
  const output = projectPrimitiveRecord(source, ROUTER_DIRECT_ROUTE_METADATA_PRIMITIVE_KEYS) ?? {};
  const requestId = readNonEmptyString(input.requestId) ?? readNonEmptyString(source.requestId);
  if (requestId) {
    output.requestId = requestId;
  }
  const entryEndpoint = readNonEmptyString(input.entryEndpoint) ?? readNonEmptyString(source.entryEndpoint);
  if (entryEndpoint) {
    output.entryEndpoint = entryEndpoint;
  }
  copyStringArrayKey(output, source, 'allowedProviders');
  copyStringArrayKey(output, source, 'excludedProviderKeys');
  output.metadataCenterSnapshot = projectRouteMetadataCenterSnapshot(
    input.metadataCenterSnapshot ?? readPlainRecord(source.metadataCenterSnapshot),
    source,
  );
  return output;
}

export function buildDirectProviderRuntimeMetadata(input: {
  metadata?: Record<string, unknown>;
  entryEndpoint?: string;
  localPort?: number;
  providerProtocol?: string;
}): Record<string, unknown> {
  const source = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
    ? input.metadata
    : {};
  const output: Record<string, unknown> = {};
  const entryEndpoint = readNonEmptyString(input.entryEndpoint) ?? readNonEmptyString(source.entryEndpoint);
  if (entryEndpoint) {
    output.entryEndpoint = entryEndpoint;
  }
  const localPort = readFiniteNumber(input.localPort)
    ?? readFiniteNumber(source.entryPort)
    ?? readFiniteNumber(source.matchedPort)
    ?? readFiniteNumber(source.routecodexLocalPort)
    ?? readFiniteNumber(source.localPort);
  if (typeof localPort === 'number') {
    output.entryPort = localPort;
    output.matchedPort = localPort;
    output.routecodexLocalPort = localPort;
  }
  const routingPolicyGroup = readNonEmptyString(source.routecodexRoutingPolicyGroup);
  if (routingPolicyGroup) {
    output.routecodexRoutingPolicyGroup = routingPolicyGroup;
  }
  for (const key of DIRECT_PROVIDER_RUNTIME_METADATA_KEYS) {
    copyPrimitiveKey(output, source, key);
  }
  if (input.providerProtocol === 'openai-responses') {
    output.__responsesDirectPassthrough = true;
  }
  propagatePipelineDryRunControl(source, output);
  return output;
}
