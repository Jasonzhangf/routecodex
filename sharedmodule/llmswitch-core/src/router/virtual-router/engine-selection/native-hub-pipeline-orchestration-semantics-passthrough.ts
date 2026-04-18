import { failNativeRequired, isNativeDisabledByEnv } from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

const NON_BLOCKING_PASSTHROUGH_LOG_THROTTLE_MS = 60_000;
const nonBlockingPassthroughLogState = new Map<string, number>();
const JSON_PARSE_FAILED = Symbol('native-hub-pipeline-orchestration-semantics-passthrough.parse-failed');

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error ?? 'unknown');
  }
}

function logNativePassthroughNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingPassthroughLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_PASSTHROUGH_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingPassthroughLogState.set(stage, now);
  console.warn(
    `[native-hub-pipeline-orchestration-semantics-passthrough] ${stage} failed (non-blocking): ${formatUnknownError(error)}`
  );
}

function parseJson(stage: string, raw: string): unknown | typeof JSON_PARSE_FAILED {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logNativePassthroughNonBlocking(stage, error);
    return JSON_PARSE_FAILED;
  }
}

function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch (error) {
    logNativePassthroughNonBlocking('safeStringify', error);
    return undefined;
  }
}

function parseBoolean(raw: string): boolean | null {
  const parsed = parseJson('parseBoolean', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  return typeof parsed === 'boolean' ? parsed : null;
}

function parseString(raw: string): string | null {
  const parsed = parseJson('parseString', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  return typeof parsed === 'string' ? parsed : null;
}

function parseStringArray(raw: string): string[] | null {
  const parsed = parseJson('parseStringArray', raw);
  if (parsed === JSON_PARSE_FAILED || !Array.isArray(parsed)) {
    return null;
  }
  const out: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'string') {
      return null;
    }
    out.push(entry);
  }
  return out;
}

function parseRecord(raw: string): Record<string, unknown> | null {
  const parsed = parseJson('parseRecord', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

export function resolveHasInstructionRequestedPassthroughWithNative(
  messages: unknown
): boolean {
  const capability = 'resolveHasInstructionRequestedPassthroughJson';
  const fail = (reason?: string): boolean => failNativeRequired<boolean>(capability, reason);

  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const messagesJson = safeStringify(messages ?? null);
  if (!messagesJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(messagesJson);
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

export function resolveActiveProcessModeWithNative(
  baseMode: 'chat' | 'passthrough',
  messages: unknown
): 'chat' | 'passthrough' {
  const capability = 'resolveActiveProcessModeJson';
  const fail = (reason?: string): 'chat' | 'passthrough' =>
    failNativeRequired<'chat' | 'passthrough'>(capability, reason);

  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const baseModeJson = safeStringify(baseMode);
  const messagesJson = safeStringify(messages ?? null);
  if (!baseModeJson || !messagesJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(baseModeJson, messagesJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseString(raw);
    if (parsed === 'chat' || parsed === 'passthrough') {
      return parsed;
    }
    return fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function findMappableSemanticsKeysWithNative(
  metadata: unknown
): string[] {
  const capability = 'findMappableSemanticsKeysJson';
  const fail = (reason?: string): string[] => failNativeRequired<string[]>(capability, reason);

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
    const parsed = parseStringArray(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildPassthroughAuditWithNative(
  rawInbound: Record<string, unknown>,
  providerProtocol: string
): Record<string, unknown> {
  const capability = 'buildPassthroughAuditJson';
  const fail = (reason?: string): Record<string, unknown> =>
    failNativeRequired<Record<string, unknown>>(capability, reason);

  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }

  const inboundJson = safeStringify(rawInbound ?? {});
  if (!inboundJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inboundJson, String(providerProtocol || ''));
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

export function annotatePassthroughGovernanceSkipWithNative(
  audit: Record<string, unknown>
): Record<string, unknown> {
  const capability = 'annotatePassthroughGovernanceSkipJson';
  const fail = (reason?: string): Record<string, unknown> =>
    failNativeRequired<Record<string, unknown>>(capability, reason);

  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }

  const auditJson = safeStringify(audit ?? {});
  if (!auditJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(auditJson);
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

export function attachPassthroughProviderInputAuditWithNative(
  audit: Record<string, unknown>,
  providerPayload: Record<string, unknown>,
  providerProtocol: string
): Record<string, unknown> {
  const capability = 'attachPassthroughProviderInputAuditJson';
  const fail = (reason?: string): Record<string, unknown> =>
    failNativeRequired<Record<string, unknown>>(capability, reason);

  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }

  const auditJson = safeStringify(audit ?? {});
  const payloadJson = safeStringify(providerPayload ?? {});
  if (!auditJson || !payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(auditJson, payloadJson, String(providerProtocol || ''));
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
