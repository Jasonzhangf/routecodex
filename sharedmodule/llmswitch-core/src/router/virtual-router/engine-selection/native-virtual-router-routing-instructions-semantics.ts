import { failNativeRequired } from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';
import { resolveRccUserDir } from '../../../runtime/user-data-paths.js';

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

function parseArrayPayload(raw: string): string[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((entry) => typeof entry === 'string') as string[];
  } catch {
    return null;
  }
}

function parseRecordPayload(raw: string): Record<string, unknown> | null {
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

function parseRecordArrayPayload(raw: string): Array<Record<string, unknown>> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    const records = parsed.filter(
      (entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ) as Array<Record<string, unknown>>;
    return records.length === parsed.length ? records : null;
  } catch {
    return null;
  }
}

function buildRoutingInstructionParseOptionsJson(): string | undefined {
  return safeStringify({
    rccUserDir: resolveRccUserDir()
  });
}

export function parseRoutingInstructionKindsWithNative(request: unknown): string[] {
  const capability = 'parseRoutingInstructionKindsJson';
  const fail = (reason?: string) => failNativeRequired<string[]>(capability, reason);
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const requestJson = safeStringify(request);
  if (!requestJson) {
    return fail('json stringify failed');
  }
  const optionsJson = buildRoutingInstructionParseOptionsJson();
  if (!optionsJson) {
    return fail('json stringify failed');
  }
  try {
    const result = fn(requestJson, optionsJson);
    if (typeof result !== 'string' || !result) {
      return fail('empty result');
    }
    const parsed = parseArrayPayload(result);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function parseRoutingInstructionsWithNative(
  messages: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const capability = 'parseRoutingInstructionsJson';
  const fail = (reason?: string) => failNativeRequired<Array<Record<string, unknown>>>(capability, reason);
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const messagesJson = safeStringify(messages);
  if (!messagesJson) {
    return fail('json stringify failed');
  }
  const optionsJson = buildRoutingInstructionParseOptionsJson();
  if (!optionsJson) {
    return fail('json stringify failed');
  }
  try {
    const result = fn(messagesJson, optionsJson);
    if (typeof result !== 'string' || !result) {
      return fail('empty result');
    }
    const parsed = parseRecordArrayPayload(result);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function cleanRoutingInstructionMarkersWithNative(
  request: Record<string, unknown>
): Record<string, unknown> {
  const capability = 'cleanRoutingInstructionMarkersJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const requestJson = safeStringify(request);
  if (!requestJson) {
    return fail('json stringify failed');
  }
  try {
    const result = fn(requestJson);
    if (typeof result !== 'string' || !result) {
      return fail('empty result');
    }
    const parsed = parseRecordPayload(result);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
