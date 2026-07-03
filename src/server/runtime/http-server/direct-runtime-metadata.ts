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
  return output;
}
