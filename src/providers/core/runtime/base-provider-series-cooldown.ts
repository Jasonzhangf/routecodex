import type { ProviderContext, ProviderRuntimeProfile } from '../api/provider-types.js';
import type { ProviderErrorAugmented } from './provider-error-types.js';

const SERIES_COOLDOWN_PROVIDER_IDS = new Set(['antigravity', 'gemini-cli']);
const SERIES_COOLDOWN_MAX_MS = 3 * 60 * 60_000;

type ModelSeriesName = 'claude' | 'gemini-pro' | 'gemini-flash' | 'default';
type QuotaDelayExtraction = {
  delay: string;
  source: 'quota_reset_delay' | 'quota_exhausted_fallback' | 'capacity_exhausted_fallback';
};

export const SERIES_COOLDOWN_DETAIL_KEY = 'virtualRouterSeriesCooldown' as const;

export type SeriesCooldownDetail = {
  scope: 'model-series';
  providerId: string;
  providerKey?: string;
  model?: string;
  series: Exclude<ModelSeriesName, 'default'>;
  cooldownMs: number;
  quotaResetDelay?: string;
  source?: string;
  expiresAt?: number;
};

export function isDailyLimitRateLimitMessage(messageLower: string, upstreamLower?: string): boolean {
  const haystack = `${messageLower} ${upstreamLower ?? ''}`;
  if (
    haystack.includes('no capacity available') ||
    haystack.includes('model_capacity_exhausted') ||
    haystack.includes('model capacity exhausted')
  ) {
    return false;
  }
  return (
    haystack.includes('daily cost limit') ||
    haystack.includes('daily quota') ||
    haystack.includes('quota has been exhausted') ||
    haystack.includes('quota exceeded') ||
    haystack.includes('resource has been exhausted') ||
    haystack.includes('resource exhausted') ||
    haystack.includes('resource_exhausted') ||
    haystack.includes('费用限制') ||
    haystack.includes('每日费用限制') ||
    haystack.includes('余额不足') ||
    haystack.includes('无可用资源包')
  );
}

export function buildSeriesCooldownDetail(
  error: ProviderErrorAugmented,
  context: ProviderContext,
  runtimeProfile?: ProviderRuntimeProfile,
  providerKey?: string
): SeriesCooldownDetail | null {
  const normalizedProviderId = normalizeSeriesProviderId(
    runtimeProfile?.providerId || context.providerId,
    providerKey
  );
  if (!normalizedProviderId) {
    return null;
  }
  const topLevelId = extractTopLevelProviderId(normalizedProviderId);
  if (!topLevelId || !SERIES_COOLDOWN_PROVIDER_IDS.has(topLevelId.toLowerCase())) {
    return null;
  }
  const extracted = extractQuotaResetDelayWithSource(error);
  if (!extracted) {
    return null;
  }
  const rawDelay = extracted.delay;
  const cooldownMs = parseDurationToMs(rawDelay);
  if (!cooldownMs || cooldownMs <= 0) {
    return null;
  }
  const cappedCooldownMs = Math.min(cooldownMs, SERIES_COOLDOWN_MAX_MS);
  const modelId = resolveContextModel(context, runtimeProfile, providerKey);
  const series = resolveModelSeries(modelId);
  if (!modelId || series === 'default') {
    return null;
  }
  return {
    scope: 'model-series',
    providerId: normalizedProviderId,
    providerKey,
    model: modelId,
    series,
    cooldownMs: cappedCooldownMs,
    quotaResetDelay: rawDelay,
    source: extracted.source,
    expiresAt: Date.now() + cappedCooldownMs
  };
}

function extractQuotaResetDelayWithSource(error: ProviderErrorAugmented): QuotaDelayExtraction | null {
  if (!error) {
    return null;
  }
  const response = error.response as { data?: unknown } | undefined;
  const textSources: string[] = [];
  const objectSources: Record<string, unknown>[] = [];
  const rawData = response?.data;
  const dataNode = normalizeObjectCandidate(rawData);
  if (dataNode) {
    objectSources.push(dataNode);
    const errBlock = normalizeObjectCandidate((dataNode as { error?: unknown })?.error);
    if (errBlock) {
      objectSources.push(errBlock);
      const details = (errBlock as { details?: unknown })?.details;
      if (Array.isArray(details)) {
        for (const detail of details) {
          const normalizedDetail = normalizeObjectCandidate(detail);
          if (normalizedDetail) {
            objectSources.push(normalizedDetail);
          }
        }
      }
      const errMessage = (errBlock as { message?: unknown })?.message;
      if (typeof errMessage === 'string') {
        textSources.push(errMessage);
      }
    }
  } else if (typeof rawData === 'string') {
    textSources.push(rawData);
  }
  if (error && typeof error === 'object') {
    objectSources.push(error as unknown as Record<string, unknown>);
  }
  if (typeof error.message === 'string') {
    textSources.push(error.message);
  }
  const upstreamMessage = (error as { upstreamMessage?: string }).upstreamMessage;
  if (typeof upstreamMessage === 'string') {
    textSources.push(upstreamMessage);
  }
  for (const source of objectSources) {
    const candidate = extractQuotaDelayFromObject(source);
    if (candidate) {
      return { delay: candidate, source: 'quota_reset_delay' };
    }
  }
  for (const text of textSources) {
    const candidate = extractQuotaDelayFromString(text);
    if (candidate) {
      return { delay: candidate, source: 'quota_reset_delay' };
    }
  }
  return extractFallbackQuotaDelayFromTexts(textSources);
}

function extractQuotaDelayFromObject(source: unknown): string | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }
  const record = source as Record<string, unknown>;
  const directDelay = record.quotaResetDelay;
  if (typeof directDelay === 'string' && directDelay.trim().length) {
    return directDelay.trim();
  }
  const metadata = record.metadata;
  if (metadata && typeof metadata === 'object') {
    const metaDelay = (metadata as Record<string, unknown>).quotaResetDelay;
    if (typeof metaDelay === 'string' && metaDelay.trim().length) {
      return metaDelay.trim();
    }
    const metaResetTs = (metadata as Record<string, unknown>).quotaResetTimeStamp;
    if (typeof metaResetTs === 'string' && metaResetTs.trim().length) {
      const ttlMs = computeTtlFromTimestamp(metaResetTs.trim());
      if (ttlMs && ttlMs > 0) {
        return `${Math.round(ttlMs / 1000)}s`;
      }
    }
  }
  const directResetTs = record.quotaResetTimeStamp;
  if (typeof directResetTs === 'string' && directResetTs.trim().length) {
    const ttlMs = computeTtlFromTimestamp(directResetTs.trim());
    if (ttlMs && ttlMs > 0) {
      return `${Math.round(ttlMs / 1000)}s`;
    }
  }
  return undefined;
}

function computeTtlFromTimestamp(value?: string): number | null {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const diff = parsed - Date.now();
  if (!Number.isFinite(diff) || diff <= 0) {
    return null;
  }
  return Math.round(diff);
}

export function parseDurationToMs(value?: string): number | null {
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
    const seconds = Number.parseFloat(value);
    if (Number.isFinite(seconds)) {
      totalMs = seconds * 1_000;
      matched = true;
    }
  }
  if (!matched || totalMs <= 0) {
    return null;
  }
  return Math.round(totalMs);
}

function normalizeSeriesProviderId(providerId?: string, providerKey?: string): string | undefined {
  const aliasFromKey = extractProviderAliasId(providerKey);
  if (aliasFromKey) {
    return aliasFromKey;
  }
  const aliasFromId = extractProviderAliasId(providerId);
  if (aliasFromId) {
    return aliasFromId;
  }
  const topFromKey = extractTopLevelProviderId(providerKey);
  if (topFromKey) {
    return topFromKey;
  }
  return extractTopLevelProviderId(providerId);
}

function normalizeObjectCandidate(value: unknown): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  if (typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function extractQuotaDelayFromString(text: string): string | undefined {
  if (typeof text !== 'string' || !text) {
    return undefined;
  }
  const match = text.match(/quotaResetDelay["']?\s*[:=]\s*"([^"]+)"/i);
  if (match && match[1]) {
    const normalized = match[1].trim();
    return normalized.length ? normalized : undefined;
  }
  return undefined;
}

function extractFallbackQuotaDelayFromTexts(texts: string[]): QuotaDelayExtraction | null {
  if (!Array.isArray(texts) || texts.length === 0) {
    return null;
  }
  const haystack = texts.join(' ').toLowerCase();
  if (!haystack) {
    return null;
  }
  if (
    haystack.includes('no capacity available') ||
    haystack.includes('model_capacity_exhausted') ||
    haystack.includes('model capacity exhausted')
  ) {
    const envValue =
      (process.env.ROUTECODEX_RL_CAPACITY_COOLDOWN || process.env.RCC_RL_CAPACITY_COOLDOWN || '').trim();
    return {
      delay: envValue.length ? envValue : '30s',
      source: 'capacity_exhausted_fallback'
    };
  }

  if (
    haystack.includes('resource has been exhausted') ||
    haystack.includes('resource exhausted') ||
    haystack.includes('quota has been exhausted') ||
    haystack.includes('quota exceeded') ||
    haystack.includes('余额不足') ||
    haystack.includes('无可用资源包')
  ) {
    const envValue =
      (process.env.ROUTECODEX_RL_DEFAULT_QUOTA_COOLDOWN || process.env.RCC_RL_DEFAULT_QUOTA_COOLDOWN || '').trim();
    return {
      delay: envValue.length ? envValue : '5m',
      source: 'quota_exhausted_fallback'
    };
  }
  return null;
}

function extractTopLevelProviderId(source?: string): string | undefined {
  if (!source || typeof source !== 'string') {
    return undefined;
  }
  const trimmed = source.trim();
  if (!trimmed) {
    return undefined;
  }
  const firstDot = trimmed.indexOf('.');
  if (firstDot <= 0) {
    return trimmed;
  }
  return trimmed.slice(0, firstDot);
}

function extractProviderAliasId(source?: string): string | undefined {
  if (!source || typeof source !== 'string') {
    return undefined;
  }
  const trimmed = source.trim();
  if (!trimmed) {
    return undefined;
  }
  const segments = trimmed.split('.');
  if (segments.length >= 2 && segments[0] && segments[1]) {
    return `${segments[0]}.${segments[1]}`;
  }
  return undefined;
}

function resolveContextModel(
  context: ProviderContext,
  runtimeProfile?: ProviderRuntimeProfile,
  providerKey?: string
): string | undefined {
  if (typeof context.model === 'string' && context.model.trim().length) {
    return context.model.trim();
  }
  const target = context.target;
  if (target && typeof target === 'object') {
    const candidate =
      (target as { clientModelId?: string }).clientModelId ||
      (target as { modelId?: string }).modelId;
    if (typeof candidate === 'string' && candidate.trim().length) {
      return candidate.trim();
    }
  }
  if (runtimeProfile?.defaultModel && runtimeProfile.defaultModel.trim().length) {
    return runtimeProfile.defaultModel.trim();
  }
  if (providerKey) {
    return deriveModelIdFromProviderKey(providerKey);
  }
  return undefined;
}

function deriveModelIdFromProviderKey(providerKey?: string): string | undefined {
  if (!providerKey) {
    return undefined;
  }
  const firstDot = providerKey.indexOf('.');
  if (firstDot <= 0 || firstDot === providerKey.length - 1) {
    return undefined;
  }
  const remainder = providerKey.slice(firstDot + 1);
  const secondDot = remainder.indexOf('.');
  if (secondDot <= 0 || secondDot === remainder.length - 1) {
    const trimmed = remainder.trim();
    return trimmed || undefined;
  }
  const finalPart = remainder.slice(secondDot + 1).trim();
  return finalPart || undefined;
}

function resolveModelSeries(model?: string): ModelSeriesName {
  if (!model) {
    return 'default';
  }
  const lower = model.toLowerCase();
  if (lower.includes('claude') || lower.includes('opus')) {
    return 'claude';
  }
  if (lower.includes('flash')) {
    return 'gemini-flash';
  }
  if (lower.includes('gemini') || lower.includes('pro')) {
    return 'gemini-pro';
  }
  return 'default';
}
