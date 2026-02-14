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
    if (body.response && typeof body.response === 'object') {
      const responseNode = body.response as Record<string, unknown>;
      if (responseNode.usage) {
        candidates.push(responseNode.usage);
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
  const basePrompt =
    typeof record.prompt_tokens === 'number'
      ? record.prompt_tokens
      : typeof record.input_tokens === 'number'
        ? record.input_tokens
        : undefined;

  let cacheRead: number | undefined =
    typeof record.cache_read_input_tokens === 'number' ? record.cache_read_input_tokens : undefined;

  if (cacheRead === undefined && record.input_tokens_details && typeof record.input_tokens_details === 'object') {
    const details = record.input_tokens_details as Record<string, unknown>;
    if (typeof details.cached_tokens === 'number') {
      cacheRead = details.cached_tokens;
    }
  }

  const prompt =
    basePrompt !== undefined || cacheRead !== undefined
      ? (basePrompt ?? 0) + (cacheRead ?? 0)
      : undefined;

  const completion =
    typeof record.completion_tokens === 'number'
      ? record.completion_tokens
      : typeof record.output_tokens === 'number'
        ? record.output_tokens
        : undefined;

  let total = typeof record.total_tokens === 'number' ? record.total_tokens : undefined;

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
