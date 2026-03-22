import { failNativeRequired, isNativeDisabledByEnv } from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

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

function parseString(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function parseStringArray(raw: string): string[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
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
