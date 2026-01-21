import type { ProviderErrorEvent } from '../../../modules/llmswitch/bridge.js';

export const AUTO_COOLDOWN_MAX_MS = 3 * 60 * 60_000;

export function capAutoCooldownMs(value?: number | null): number | null {
  if (!value || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.min(Math.floor(value), AUTO_COOLDOWN_MAX_MS);
}

export function capAutoCooldownUntil(until: number, nowMs: number): number {
  const maxUntil = nowMs + AUTO_COOLDOWN_MAX_MS;
  if (!Number.isFinite(until) || until <= nowMs) {
    return maxUntil;
  }
  return Math.min(until, maxUntil);
}

function extractVirtualRouterSeriesCooldownUntil(event: ProviderErrorEvent, nowMs: number): number | null {
  if (!event || !event.details || typeof event.details !== 'object') {
    return null;
  }
  const raw = (event.details as Record<string, unknown>).virtualRouterSeriesCooldown;
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const cooldownMsRaw = record.cooldownMs;
  const expiresAtRaw = record.expiresAt;
  const expiresAt =
    typeof expiresAtRaw === 'number' && Number.isFinite(expiresAtRaw) && expiresAtRaw > nowMs
      ? expiresAtRaw
      : null;
  if (expiresAt) {
    return expiresAt;
  }
  const cooldownMs =
    typeof cooldownMsRaw === 'number'
      ? cooldownMsRaw
      : typeof cooldownMsRaw === 'string'
        ? Number.parseFloat(cooldownMsRaw)
        : Number.NaN;
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) {
    return null;
  }
  return nowMs + cooldownMs;
}

export function extractVirtualRouterSeriesCooldown(
  event: ProviderErrorEvent,
  nowMs: number
): { until: number; source?: string } | null {
  if (!event || !event.details || typeof event.details !== 'object') {
    return null;
  }
  const raw = (event.details as Record<string, unknown>).virtualRouterSeriesCooldown;
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const until = extractVirtualRouterSeriesCooldownUntil(event, nowMs);
  if (!until) {
    return null;
  }
  const source =
    typeof record.source === 'string' && record.source.trim().length ? record.source.trim() : undefined;
  return { until, source };
}

export function parseQuotaResetDelayMs(event: ProviderErrorEvent): number | null {
  const message = typeof event.message === 'string' ? event.message : '';
  const raw = message.toLowerCase();

  // Common shape: "reset after 3h22m41s" (Gemini quota exhausted)
  const afterMatch = raw.match(/reset after\s+([0-9a-z.\s]+)\.?/i);
  if (afterMatch && afterMatch[1]) {
    const parsed = parseDurationToMs(afterMatch[1]);
    if (parsed && parsed > 0) {
      return parsed;
    }
  }

  // Sometimes the upstream JSON is embedded; try extracting quotaResetDelay.
  const embeddedDelayMatch = raw.match(/quotaresetdelay\"\s*:\s*\"([^\"]+)\"/i);
  if (embeddedDelayMatch && embeddedDelayMatch[1]) {
    const parsed = parseDurationToMs(embeddedDelayMatch[1]);
    if (parsed && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function parseDurationToMs(value?: string): number | null {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/gi;
  let totalMs = 0;
  let matched = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    matched = true;
    const amount = Number.parseFloat(match[1]);
    if (!Number.isFinite(amount)) {
      continue;
    }
    const unit = match[2].toLowerCase();
    if (unit === 'ms') {
      totalMs += amount;
    } else if (unit === 'h') {
      totalMs += amount * 3_600_000;
    } else if (unit === 'm') {
      totalMs += amount * 60_000;
    } else if (unit === 's') {
      totalMs += amount * 1_000;
    }
  }
  if (!matched) {
    return null;
  }
  if (totalMs <= 0) {
    return null;
  }
  return Math.round(totalMs);
}

