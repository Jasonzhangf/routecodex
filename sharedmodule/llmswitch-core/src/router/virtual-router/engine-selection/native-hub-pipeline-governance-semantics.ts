import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

export interface NativeToolGovernanceRules {
  maxNameLength?: number;
  allowedCharacters?: unknown;
  forceCase?: 'lower' | 'upper';
  defaultName?: string;
  trimWhitespace?: boolean;
  onViolation?: 'truncate' | 'reject';
}

export interface NativeToolGovernanceRuleNode {
  request?: NativeToolGovernanceRules;
  response?: NativeToolGovernanceRules;
}

export type NativeToolGovernanceRegistry = Record<string, NativeToolGovernanceRuleNode>;

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

function normalizeAllowedCharactersToken(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const token = value.trim();
    return token || undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  if (typeof row.source === 'string' && row.source.trim()) {
    return row.source.trim();
  }
  return undefined;
}

function normalizeRulesForNative(
  rules: NativeToolGovernanceRules | undefined
): NativeToolGovernanceRules | undefined {
  if (!rules || typeof rules !== 'object') {
    return undefined;
  }
  const normalizedAllowed = normalizeAllowedCharactersToken(rules.allowedCharacters);
  return {
    ...rules,
    ...(normalizedAllowed ? { allowedCharacters: normalizedAllowed } : {})
  };
}

function normalizeRegistryForNative(
  registry: NativeToolGovernanceRegistry | undefined
): NativeToolGovernanceRegistry | undefined {
  if (!registry || typeof registry !== 'object') {
    return undefined;
  }
  const out: NativeToolGovernanceRegistry = {};
  for (const [protocol, node] of Object.entries(registry)) {
    out[protocol] = {
      request: normalizeRulesForNative(node?.request),
      response: normalizeRulesForNative(node?.response)
    };
  }
  return out;
}

function parseRegistry(raw: string): NativeToolGovernanceRegistry | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as NativeToolGovernanceRegistry;
  } catch {
    return null;
  }
}

function readNativeErrorReason(value: unknown): string | undefined {
  if (value instanceof Error) {
    const text = value.message.trim();
    return text || String(value);
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const message = typeof row.message === 'string' ? row.message.trim() : '';
  if (message) {
    return message;
  }
  return undefined;
}

export function resolveDefaultToolGovernanceRulesWithNative(): NativeToolGovernanceRegistry {
  const capability = 'resolveDefaultToolGovernanceRulesJson';
  const fail = (reason?: string) => failNativeRequired<NativeToolGovernanceRegistry>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn();
    const errorReason = readNativeErrorReason(raw);
    if (errorReason) {
      return fail(errorReason);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRegistry(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function governRequestWithNative(input: {
  request: Record<string, unknown>;
  protocol?: string;
  registry?: NativeToolGovernanceRegistry;
}): { request: Record<string, unknown>; summary: Record<string, unknown> } {
  const capability = 'governRequestJson';
  const fail = (reason?: string) => failNativeRequired<{ request: Record<string, unknown>; summary: Record<string, unknown> }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const normalizedInput = {
    ...input,
    registry: normalizeRegistryForNative(input.registry)
  };
  const inputJson = safeStringify(normalizedInput);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    const errorReason = readNativeErrorReason(raw);
    if (errorReason) {
      return fail(errorReason);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    const row = parsed as Record<string, unknown>;
    if (!row.request || typeof row.request !== 'object' || Array.isArray(row.request)) {
      return fail('invalid request payload');
    }
    if (!row.summary || typeof row.summary !== 'object' || Array.isArray(row.summary)) {
      return fail('invalid summary payload');
    }
    return {
      request: row.request as Record<string, unknown>,
      summary: row.summary as Record<string, unknown>
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function governResponseWithNative(input: {
  payload: Record<string, unknown>;
  protocol?: string;
  registry?: NativeToolGovernanceRegistry;
}): { payload: Record<string, unknown>; summary: Record<string, unknown> } {
  const capability = 'governToolNameResponseJson';
  const fail = (reason?: string) => failNativeRequired<{ payload: Record<string, unknown>; summary: Record<string, unknown> }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const normalizedInput = {
    ...input,
    registry: normalizeRegistryForNative(input.registry)
  };
  const inputJson = safeStringify(normalizedInput);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    const errorReason = readNativeErrorReason(raw);
    if (errorReason) {
      return fail(errorReason);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    const row = parsed as Record<string, unknown>;
    if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) {
      return fail('invalid response payload');
    }
    if (!row.summary || typeof row.summary !== 'object' || Array.isArray(row.summary)) {
      return fail('invalid summary payload');
    }
    return {
      payload: row.payload as Record<string, unknown>,
      summary: row.summary as Record<string, unknown>
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
