import { failNativeRequired, isNativeDisabledByEnv } from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

type LiftedResponsesResume = {
  request: Record<string, unknown>;
  metadata: Record<string, unknown>;
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

function parseBoolean(raw: string): boolean | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'boolean' ? parsed : null;
  } catch {
    return null;
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

function parseOptionalRecord(raw: string): Record<string, unknown> | undefined | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) {
      return undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseLiftResponsesResumeIntoSemanticsOutput(raw: string): LiftedResponsesResume | null {
  const parsed = parseRecord(raw);
  if (!parsed) {
    return null;
  }
  const request =
    parsed.request && typeof parsed.request === 'object' && !Array.isArray(parsed.request)
      ? (parsed.request as Record<string, unknown>)
      : null;
  const metadata =
    parsed.metadata && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata)
      ? (parsed.metadata as Record<string, unknown>)
      : null;
  if (!request || !metadata) {
    return null;
  }
  return { request, metadata };
}

export function isSearchRouteIdWithNative(routeId: unknown): boolean {
  const capability = 'isSearchRouteIdJson';
  const fail = (reason?: string): boolean => failNativeRequired<boolean>(capability, reason);

  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const routeIdJson = safeStringify(routeId ?? null);
  if (!routeIdJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(routeIdJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseBoolean(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function isCanonicalWebSearchToolDefinitionWithNative(tool: unknown): boolean {
  const capability = 'isCanonicalWebSearchToolDefinitionJson';
  const fail = (reason?: string): boolean => failNativeRequired<boolean>(capability, reason);

  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const toolJson = safeStringify(tool ?? null);
  if (!toolJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(toolJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseBoolean(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function applyDirectBuiltinWebSearchToolWithNative(
  providerPayload: Record<string, unknown>,
  providerProtocol: string,
  routeId: unknown,
  runtimeMetadata: Record<string, unknown> | undefined
): Record<string, unknown> {
  const capability = 'applyDirectBuiltinWebSearchToolJson';
  const fail = (reason?: string): Record<string, unknown> =>
    failNativeRequired<Record<string, unknown>>(capability, reason);

  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(providerPayload ?? {});
  const routeIdJson = safeStringify(routeId ?? null);
  const runtimeMetadataJson = safeStringify(runtimeMetadata ?? null);
  if (!payloadJson || !routeIdJson || !runtimeMetadataJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson, String(providerProtocol || ''), routeIdJson, runtimeMetadataJson);
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

export function liftResponsesResumeIntoSemanticsWithNative(
  request: Record<string, unknown>,
  metadata: Record<string, unknown>
): LiftedResponsesResume {
  const capability = 'liftResponsesResumeIntoSemanticsJson';
  const fail = (reason?: string): LiftedResponsesResume =>
    failNativeRequired<LiftedResponsesResume>(capability, reason);

  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const requestJson = safeStringify(request ?? {});
  const metadataJson = safeStringify(metadata ?? {});
  if (!requestJson || !metadataJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(requestJson, metadataJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseLiftResponsesResumeIntoSemanticsOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function syncResponsesContextFromCanonicalMessagesWithNative(
  request: Record<string, unknown>
): Record<string, unknown> {
  const capability = 'syncResponsesContextFromCanonicalMessagesJson';
  const fail = (reason?: string): Record<string, unknown> =>
    failNativeRequired<Record<string, unknown>>(capability, reason);

  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const requestJson = safeStringify(request ?? {});
  if (!requestJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(requestJson);
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

export function readResponsesResumeFromMetadataWithNative(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const capability = 'readResponsesResumeFromMetadataJson';
  const fail = (reason?: string): Record<string, unknown> | undefined =>
    failNativeRequired<Record<string, unknown> | undefined>(capability, reason);

  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const metadataJson = safeStringify(metadata ?? null);
  if (!metadataJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(metadataJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseOptionalRecord(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function readResponsesResumeFromRequestSemanticsWithNative(
  request: unknown
): Record<string, unknown> | undefined {
  const capability = 'readResponsesResumeFromRequestSemanticsJson';
  const fail = (reason?: string): Record<string, unknown> | undefined =>
    failNativeRequired<Record<string, unknown> | undefined>(capability, reason);

  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const requestJson = safeStringify(request ?? null);
  if (!requestJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(requestJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseOptionalRecord(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
