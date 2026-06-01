import { DEFAULT_CONTEXT_ROUTING } from './config-defaults.js';
import type { VirtualRouterConfig, VirtualRouterContextRoutingConfig } from '../types.js';

export function normalizeExecCommandGuard(input: unknown): VirtualRouterConfig['execCommandGuard'] | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    // Default to enabled when not configured
    return { enabled: true };
  }
  const record = input as Record<string, unknown>;
  const enabledRaw = record.enabled;
  // Explicit false disables the guard; default is true
  const enabled =
    enabledRaw !== false &&
    !(typeof enabledRaw === 'string' && enabledRaw.trim().toLowerCase() === 'false') &&
    !(typeof enabledRaw === 'number' && enabledRaw === 0);
  if (!enabled) {
    return undefined;
  }
  const policyFileRaw = record.policyFile ?? (record as any).policy_file;
  const policyFile =
    typeof policyFileRaw === 'string' && policyFileRaw.trim().length ? policyFileRaw.trim() : undefined;
  return {
    enabled: true,
    ...(policyFile ? { policyFile } : {})
  };
}

export function normalizeContextRouting(input: unknown): VirtualRouterContextRoutingConfig {
  if (!input || typeof input !== 'object') {
    return { ...DEFAULT_CONTEXT_ROUTING };
  }
  const record = input as Record<string, unknown>;
  const warnCandidate = coerceRatio(record.warnRatio) ?? coerceRatio((record as any).warn_ratio);
  const hardLimitCandidate = coerceBoolean(record.hardLimit) ?? coerceBoolean((record as any).hard_limit);
  const warnRatio = clampWarnRatio(warnCandidate ?? DEFAULT_CONTEXT_ROUTING.warnRatio);
  const hardLimit =
    typeof hardLimitCandidate === 'boolean' ? hardLimitCandidate : DEFAULT_CONTEXT_ROUTING.hardLimit;
  return {
    warnRatio,
    hardLimit
  };
}

function coerceRatio(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function clampWarnRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CONTEXT_ROUTING.warnRatio;
  }
  const clamped = Math.max(0.1, Math.min(value, 0.99));
  return Number.isFinite(clamped) ? clamped : DEFAULT_CONTEXT_ROUTING.warnRatio;
}

function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }
    if (['true', '1', 'yes', 'y'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'n'].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}
