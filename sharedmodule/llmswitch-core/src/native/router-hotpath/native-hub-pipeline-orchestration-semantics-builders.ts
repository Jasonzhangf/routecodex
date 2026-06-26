import { failNativeRequired, isNativeDisabledByEnv } from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

type RouterMetadataInputBuildInput = {
  requestId: string;
  entryEndpoint: string;
  processMode: 'chat';
  stream: boolean;
  direction: 'request' | 'response';
  providerProtocol: string;
  routeHint?: string;
  stage?: 'inbound' | 'outbound';
  responsesResume?: unknown;
  requestSemantics?: unknown;
  includeEstimatedInputTokens?: boolean;
  serverToolRequired?: boolean;
  sessionId?: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;
  metadataCenterSnapshot?: {
    requestTruth?: Record<string, unknown>;
    continuationContext?: Record<string, unknown>;
    runtimeControl?: Record<string, unknown>;
  };
};

type CoerceStandardizedRequestInput = {
  payload: Record<string, unknown>;
  normalized: {
    id: string;
    entryEndpoint: string;
    stream: boolean;
    processMode: 'chat';
    routeHint?: string;
  };
};

type CoerceStandardizedRequestOutput = {
  standardizedRequest: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
};

function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function parseRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseCoerceStandardizedRequestOutput(raw: string): CoerceStandardizedRequestOutput | null {
  const parsed = parseRecord(raw);
  if (!parsed) {
    return null;
  }
  const standardizedRequest =
    parsed.standardizedRequest &&
    typeof parsed.standardizedRequest === 'object' &&
    !Array.isArray(parsed.standardizedRequest)
      ? (parsed.standardizedRequest as Record<string, unknown>)
      : null;
  const rawPayload =
    parsed.rawPayload &&
    typeof parsed.rawPayload === 'object' &&
    !Array.isArray(parsed.rawPayload)
      ? (parsed.rawPayload as Record<string, unknown>)
      : null;
  if (!standardizedRequest || !rawPayload) {
    return null;
  }
  return { standardizedRequest, rawPayload };
}

export function buildRouterMetadataInputWithNative(input: RouterMetadataInputBuildInput): Record<string, unknown> {
  const capability = 'buildRouterMetadataInputJson';
  const fail = (reason?: string): Record<string, unknown> =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? {});
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function coerceStandardizedRequestFromPayloadWithNative(
  input: CoerceStandardizedRequestInput
): CoerceStandardizedRequestOutput {
  const capability = 'coerceStandardizedRequestFromPayloadJson';
  const fail = (reason?: string): CoerceStandardizedRequestOutput =>
    failNativeRequired<CoerceStandardizedRequestOutput>(capability, reason);

  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? {});
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseCoerceStandardizedRequestOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
