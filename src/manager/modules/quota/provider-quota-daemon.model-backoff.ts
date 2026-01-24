import type { ProviderErrorEvent } from '../../../modules/llmswitch/bridge.js';
import { canonicalizeProviderKey } from './provider-key-normalization.js';

type BackoffState = {
  lastErrorKey: string | null;
  lastErrorAtMs: number | null;
  consecutiveCount: number;
  cooldownUntil: number | null;
};

/**
 * When upstream explicitly reports "model capacity exhausted" (429),
 * treat it as a *capacity* signal rather than a quota signal:
 * - quota may still be available locally, but the upstream cannot serve the model right now.
 * - we cool down the *entire model series* immediately to avoid hammering 429s.
 */
const MODEL_CAPACITY_EXHAUSTED_COOLDOWN_MS = 15_000;

const DEFAULT_CAPACITY_COOLDOWN_SCHEDULE_MS = [
  15_000,
  30_000,
  60_000,
  300_000,
  1_800_000,
  3_600_000,
  10_000_000
] as const;

const DEFAULT_ERROR_CHAIN_WINDOW_MS = 10 * 60_000;

function resolveErrorKey(event: ProviderErrorEvent): string {
  const code = typeof event.code === 'string' ? event.code.trim().toUpperCase() : '';
  if (code) {
    return code;
  }
  const status = typeof event.status === 'number' && Number.isFinite(event.status) ? Math.floor(event.status) : null;
  if (status) {
    return `HTTP_${status}`;
  }
  return 'ERR_UNKNOWN';
}

function resolveModelKey(providerKey: string): string | null {
  const raw = typeof providerKey === 'string' ? providerKey.trim() : '';
  const canonical = raw ? canonicalizeProviderKey(raw) : '';
  if (!canonical) {
    return null;
  }
  const parts = canonical.split('.').filter(Boolean);
  if (parts.length < 3) {
    return null;
  }
  const providerId = parts[0]!;
  // NOTE: Upstream "MODEL_CAPACITY_EXHAUSTED" can be account/quota-style scoped for some providers
  // (e.g. antigravity), where switching aliases can help. For those providers, model backoff should
  // remain per-providerKey (which already includes the alias).
  if (providerId === 'antigravity' || providerId === 'gemini-cli') {
    return canonical;
  }
  const modelId = parts.slice(2).join('.');
  if (!providerId || !modelId) {
    return null;
  }
  return `${providerId}.${modelId}`;
}

function readPositiveIntFromEnv(name: string): number | null {
  const raw = String(process.env[name] || '').trim();
  if (!raw) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function readScheduleFromEnv(name: string): number[] | null {
  const raw = String(process.env[name] || '').trim();
  if (!raw) {
    return null;
  }
  const parts = raw
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  const schedule: number[] = [];
  for (const part of parts) {
    const ms = parseDurationToMs(part);
    if (ms && ms > 0) {
      schedule.push(ms);
    }
  }
  return schedule.length ? schedule : null;
}

function parseDurationToMs(value: string): number | null {
  const v = String(value || '').trim();
  if (!v) {
    return null;
  }
  const match = v.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!match) {
    return null;
  }
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  const unit = (match[2] || 's').toLowerCase();
  if (unit === 'ms') {
    return Math.round(amount);
  }
  if (unit === 's') {
    return Math.round(amount * 1_000);
  }
  if (unit === 'm') {
    return Math.round(amount * 60_000);
  }
  if (unit === 'h') {
    return Math.round(amount * 3_600_000);
  }
  return null;
}

export function isModelCapacityExhausted429(event: ProviderErrorEvent): boolean {
  const status = typeof event.status === 'number' ? event.status : undefined;
  if (status !== 429) {
    return false;
  }
  const details = event.details && typeof event.details === 'object' ? (event.details as Record<string, unknown>) : null;
  const upstreamMessage =
    details && typeof details.upstreamMessage === 'string' ? details.upstreamMessage : '';
  const msg = `${event.message || ''} ${upstreamMessage}`.toLowerCase();
  return (
    msg.includes('model_capacity_exhausted') ||
    msg.includes('no capacity available for model') ||
    msg.includes('capacity exhausted')
  );
}

export class ProviderModelBackoffTracker {
  private readonly states: Map<string, BackoffState> = new Map();
  private readonly schedule: number[];
  private readonly chainWindowMs: number;

  constructor() {
    this.schedule =
      readScheduleFromEnv('ROUTECODEX_MODEL_CAPACITY_SCHEDULE') ??
      readScheduleFromEnv('RCC_MODEL_CAPACITY_SCHEDULE') ??
      Array.from(DEFAULT_CAPACITY_COOLDOWN_SCHEDULE_MS);
    this.chainWindowMs =
      readPositiveIntFromEnv('ROUTECODEX_MODEL_ERROR_CHAIN_WINDOW_MS') ??
      readPositiveIntFromEnv('RCC_MODEL_ERROR_CHAIN_WINDOW_MS') ??
      DEFAULT_ERROR_CHAIN_WINDOW_MS;
  }

  recordCapacity429(providerKey: string, event: ProviderErrorEvent, nowMs: number, untilOverrideMs?: number | null): void {
    const modelKey = resolveModelKey(providerKey);
    if (!modelKey) {
      return;
    }
    const errorKey = resolveErrorKey(event);
    const previous = this.states.get(modelKey);
    const withinWindow =
      previous?.lastErrorAtMs !== null &&
      typeof previous?.lastErrorAtMs === 'number' &&
      nowMs - previous.lastErrorAtMs >= 0 &&
      nowMs - previous.lastErrorAtMs <= this.chainWindowMs;
    const sameError = withinWindow && previous?.lastErrorKey === errorKey;
    const nextCount = sameError ? (previous?.consecutiveCount ?? 0) + 1 : 1;
    const wrappedCount = nextCount > this.schedule.length ? 1 : nextCount;
    // Capacity exhausted should cool down immediately, regardless of quota manager state.
    // Use a fixed TTL by default, but keep the schedule/env overrides for debugging/tuning.
    const ttl =
      this.schedule[Math.min(wrappedCount - 1, this.schedule.length - 1)] ??
      this.schedule[0] ??
      MODEL_CAPACITY_EXHAUSTED_COOLDOWN_MS;
    const explicitUntil =
      typeof untilOverrideMs === 'number' && Number.isFinite(untilOverrideMs) && untilOverrideMs > nowMs
        ? untilOverrideMs
        : null;
    const until = explicitUntil ?? (nowMs + ttl);
    const existingUntil =
      typeof previous?.cooldownUntil === 'number' && Number.isFinite(previous.cooldownUntil)
        ? previous.cooldownUntil
        : null;
    this.states.set(modelKey, {
      lastErrorKey: errorKey,
      lastErrorAtMs: nowMs,
      consecutiveCount: wrappedCount,
      cooldownUntil: existingUntil && existingUntil > until ? existingUntil : until
    });
  }

  recordSuccess(providerKey: string): void {
    const modelKey = resolveModelKey(providerKey);
    if (!modelKey) {
      return;
    }
    this.states.delete(modelKey);
  }

  getActiveCooldownUntil(providerKey: string, nowMs: number): number | null {
    const modelKey = resolveModelKey(providerKey);
    if (!modelKey) {
      return null;
    }
    const entry = this.states.get(modelKey);
    if (!entry || entry.cooldownUntil === null) {
      return null;
    }
    if (nowMs >= entry.cooldownUntil) {
      this.states.delete(modelKey);
      return null;
    }
    return entry.cooldownUntil;
  }
}
