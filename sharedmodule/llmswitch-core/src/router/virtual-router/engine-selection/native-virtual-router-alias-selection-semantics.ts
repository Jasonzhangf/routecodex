import {
  failNativeRequired
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';
import type { AliasSelectionConfig, AliasSelectionStrategy } from '../types.js';

type NativeAliasQueuePinPayload = {
  queue: string[];
  desiredOrder: string[];
  excludedAliases: string[];
  aliasBuckets: Record<string, string[]>;
  candidateOrder: string[];
  availabilityByAlias: Record<string, boolean>;
};

type NativeAliasQueuePinOutput = {
  queue: string[];
  selectedCandidates: string[];
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

function parseAliasSelectionStrategy(raw: string): AliasSelectionStrategy | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === 'none' || parsed === 'sticky-queue') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function parseAliasQueuePinOutput(raw: string): NativeAliasQueuePinOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    if (!Array.isArray(row.queue) || !Array.isArray(row.selectedCandidates)) {
      return null;
    }
    const queue = row.queue.filter((v): v is string => typeof v === 'string');
    const selectedCandidates = row.selectedCandidates.filter((v): v is string => typeof v === 'string');
    return {
      queue,
      selectedCandidates
    };
  } catch {
    return null;
  }
}

export function resolveAliasSelectionStrategyWithNative(
  providerId: string,
  cfg: AliasSelectionConfig | undefined
): AliasSelectionStrategy {
  const capability = 'resolveAliasSelectionStrategyJson';
  const fail = (reason?: string) => failNativeRequired<AliasSelectionStrategy>(capability, reason);
  const fn = readNativeFunction('resolveAliasSelectionStrategyJson');
  if (!fn) {
    return fail();
  }
  const cfgJson = safeStringify(cfg ?? null);
  if (!cfgJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(String(providerId || ''), cfgJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseAliasSelectionStrategy(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function pinAliasQueueWithNative(
  payload: NativeAliasQueuePinPayload
): NativeAliasQueuePinOutput {
  const capability = 'pinAliasQueueJson';
  const fail = (reason?: string) => failNativeRequired<NativeAliasQueuePinOutput>(capability, reason);
  const fn = readNativeFunction('pinAliasQueueJson');
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseAliasQueuePinOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
