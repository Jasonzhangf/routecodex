/**
 * Usage Aggregator for request-executor
 *
 * Handles token usage extraction, normalization, and merging.
 */

import type { UsageMetrics } from '../stats-manager.js';

export { type UsageMetrics };

const NON_BLOCKING_LOG_THROTTLE_MS = 60_000;
const nonBlockingLogState = new Map<string, number>();

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function logUsageAggregatorNonBlockingError(
  stage: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  const now = Date.now();
  const last = nonBlockingLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingLogState.set(stage, now);
  try {
    const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[usage-aggregator] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`);
  } catch {
    // Never throw from non-blocking logging.
  }
}

/**
 * Extract usage metrics from provider response
 */
export function extractUsageFromResult(
  result: { body?: unknown; status?: number; headers?: Record<string, string> },
  metadata?: Record<string, unknown>
): UsageMetrics | undefined {
  void metadata;
  const candidates: unknown[] = [];

  if (result.body && typeof result.body === 'object') {
    const body = result.body as Record<string, unknown>;
    if (body.usage) {
      candidates.push(body.usage);
    }
    if (body.metadata && typeof body.metadata === 'object') {
      const bodyMeta = body.metadata as Record<string, unknown>;
      if (bodyMeta.usage) {
        candidates.push(bodyMeta.usage);
      }
    }
    if (body.data && typeof body.data === 'object') {
      const bodyData = body.data as Record<string, unknown>;
      if (bodyData.usage) {
        candidates.push(bodyData.usage);
      }
      if (bodyData.metadata && typeof bodyData.metadata === 'object') {
        const bodyDataMeta = bodyData.metadata as Record<string, unknown>;
        if (bodyDataMeta.usage) {
          candidates.push(bodyDataMeta.usage);
        }
      }
    }
    if (body.response && typeof body.response === 'object') {
      const responseNode = body.response as Record<string, unknown>;
      if (responseNode.usage) {
        candidates.push(responseNode.usage);
      }
    }
    if (body.payload && typeof body.payload === 'object') {
      const payload = body.payload as Record<string, unknown>;
      if (payload.usage) {
        candidates.push(payload.usage);
      }
      if (payload.metadata && typeof payload.metadata === 'object') {
        const payloadMeta = payload.metadata as Record<string, unknown>;
        if (payloadMeta.usage) {
          candidates.push(payloadMeta.usage);
        }
      }
      if (payload.response && typeof payload.response === 'object') {
        const payloadResponse = payload.response as Record<string, unknown>;
        if (payloadResponse.usage) {
          candidates.push(payloadResponse.usage);
        }
      }
    }
  }

  if (result.headers && typeof result.headers === 'object') {
    const usageHeader =
      (result.headers['x-usage'] || result.headers['X-Usage'] || result.headers['x-routecodex-usage']) as unknown;
    if (typeof usageHeader === 'string' && usageHeader.trim()) {
      try {
        candidates.push(JSON.parse(usageHeader));
      } catch (error) {
        logUsageAggregatorNonBlockingError('extractUsageFromResult.parseUsageHeader', error, {
          headerLength: usageHeader.length
        });
      }
    }
  }

  for (const candidate of candidates) {
    const normalized = normalizeUsage(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

/**
 * Normalize usage metrics from various provider formats
 */
export function normalizeUsage(value: unknown): UsageMetrics | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const usageRecord =
    record.usageMetadata && typeof record.usageMetadata === 'object'
      ? (record.usageMetadata as Record<string, unknown>)
      : record;

  const readNumeric = (raw: unknown): number | undefined => {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw;
    }
    if (typeof raw === 'string' && raw.trim()) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return undefined;
  };
  const basePrompt =
    readNumeric(usageRecord.prompt_tokens) ??
    readNumeric(usageRecord.input_tokens) ??
    readNumeric(usageRecord.promptTokens) ??
    readNumeric(usageRecord.inputTokens) ??
    readNumeric(usageRecord.request_tokens) ??
    readNumeric(usageRecord.requestTokens);

  let cacheRead: number | undefined =
    readNumeric(usageRecord.cache_read_input_tokens);

  if (cacheRead === undefined && usageRecord.input_tokens_details && typeof usageRecord.input_tokens_details === 'object') {
    const details = usageRecord.input_tokens_details as Record<string, unknown>;
    const cached = readNumeric(details.cached_tokens);
    if (cached !== undefined) {
      cacheRead = cached;
    }
  }

  const prompt =
    basePrompt !== undefined || cacheRead !== undefined
      ? (basePrompt ?? 0) + (cacheRead ?? 0)
      : undefined;

  const completion =
    readNumeric(usageRecord.completion_tokens) ??
    readNumeric(usageRecord.output_tokens) ??
    readNumeric(usageRecord.completionTokens) ??
    readNumeric(usageRecord.outputTokens) ??
    readNumeric(usageRecord.response_tokens) ??
    readNumeric(usageRecord.responseTokens);

  let total =
    readNumeric(usageRecord.total_tokens) ??
    readNumeric(usageRecord.totalTokens);

  if (prompt !== undefined && completion !== undefined) {
    const expected = prompt + completion;
    if (total === undefined || total < expected) {
      total = expected;
    }
  }

  if (prompt === undefined && completion === undefined && total === undefined) {
    return undefined;
  }

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total
  };
}

/**
 * Merge multiple usage metrics
 */
export function mergeUsageMetrics(base?: UsageMetrics, delta?: UsageMetrics): UsageMetrics | undefined {
  if (!delta) {
    return base;
  }
  if (!base) {
    return { ...delta };
  }

  const merged: UsageMetrics = {
    prompt_tokens: (base.prompt_tokens ?? 0) + (delta.prompt_tokens ?? 0),
    completion_tokens: (base.completion_tokens ?? 0) + (delta.completion_tokens ?? 0)
  };

  const total = (base.total_tokens ?? 0) + (delta.total_tokens ?? 0);
  merged.total_tokens = total || undefined;

  return merged;
}

/**
 * Build usage log text for logging
 */
export function buildUsageLogText(usage?: UsageMetrics): string {
  const inputTokens = usage?.prompt_tokens;
  let outputTokens = usage?.completion_tokens;
  const total =
    usage?.total_tokens ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);
  if (outputTokens === undefined && total !== undefined && inputTokens !== undefined) {
    outputTokens = Math.max(0, total - inputTokens);
  }
  return `input_tokens=${inputTokens ?? 'n/a'} output_tokens=${outputTokens ?? 'n/a'} total_tokens=${total ?? 'n/a'}`;
}
