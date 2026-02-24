/**
 * Usage Aggregator for request-executor
 *
 * Handles token usage extraction, normalization, and merging.
 */

import type { UsageMetrics } from '../stats-manager.js';

export { type UsageMetrics };

/**
 * Extract usage metrics from provider response
 */
export function extractUsageFromResult(
  result: { body?: unknown; status?: number; headers?: Record<string, string> },
  metadata?: Record<string, unknown>
): UsageMetrics | undefined {
  const estimatedInput = extractEstimatedInputTokens(metadata);
  const candidates: unknown[] = [];

  if (metadata && typeof metadata === 'object') {
    const bag = metadata as Record<string, unknown>;
    if (bag.usage) {
      candidates.push(bag.usage);
    }
  }

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
      } catch {
        // ignore non-json usage header
      }
    }
  }

  for (const candidate of candidates) {
    const normalized = normalizeUsage(candidate);
    if (normalized) {
      const reconciled = reconcileUsageWithEstimate(normalized, estimatedInput, candidate);
      return reconciled;
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

  if (total === undefined && prompt !== undefined && completion !== undefined) {
    total = prompt + completion;
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
 * Extract estimated input tokens from metadata
 */
export function extractEstimatedInputTokens(metadata?: Record<string, unknown>): number | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const bag = metadata as Record<string, unknown>;
  const raw =
    (bag.estimatedInputTokens as unknown) ??
    (bag.estimated_tokens as unknown) ??
    (bag.estimatedTokens as unknown);
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

/**
 * Reconcile upstream usage with local estimate
 */
export function reconcileUsageWithEstimate(
  usage: UsageMetrics,
  estimatedInput?: number,
  candidate?: unknown
): UsageMetrics {
  if (!estimatedInput || !Number.isFinite(estimatedInput) || estimatedInput <= 0) {
    return usage;
  }

  const upstreamPrompt = usage.prompt_tokens ?? usage.total_tokens ?? undefined;
  const completion = usage.completion_tokens ?? 0;

  // Use local estimate if upstream is missing
  if (upstreamPrompt === undefined || upstreamPrompt <= 0) {
    const total = estimatedInput + completion;
    patchUsageCandidate(candidate, estimatedInput, completion, total);
    return {
      prompt_tokens: estimatedInput,
      completion_tokens: completion,
      total_tokens: total
    };
  }

  const ratio = upstreamPrompt > 0 ? upstreamPrompt / estimatedInput : 1;

  // Use local estimate if difference is too large
  if (ratio > 5 || ratio < 0.2) {
    const total = estimatedInput + completion;
    patchUsageCandidate(candidate, estimatedInput, completion, total);
    return {
      prompt_tokens: estimatedInput,
      completion_tokens: completion,
      total_tokens: total
    };
  }

  return usage;
}

/**
 * Patch usage candidate object with reconciled values
 */
export function patchUsageCandidate(
  candidate: unknown,
  prompt: number,
  completion: number,
  total: number
): void {
  if (!candidate || typeof candidate !== 'object') {
    return;
  }
  const record = candidate as Record<string, unknown>;
  record.prompt_tokens = prompt;
  record.input_tokens = prompt;
  record.completion_tokens = completion;
  record.output_tokens = completion;
  record.total_tokens = total;
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
  const requestTokens = usage?.prompt_tokens;
  let responseTokens = usage?.completion_tokens;
  const total =
    usage?.total_tokens ??
    (requestTokens !== undefined && responseTokens !== undefined
      ? requestTokens + responseTokens
      : undefined);
  if (responseTokens === undefined && total !== undefined && requestTokens !== undefined) {
    responseTokens = Math.max(0, total - requestTokens);
  }
  return `request=${requestTokens ?? 'n/a'} response=${responseTokens ?? 'n/a'} total=${total ?? 'n/a'}`;
}
