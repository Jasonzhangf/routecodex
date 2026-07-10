/**
 * Shared pure formatting functions extracted from log-rollup.ts.
 *
 * Zero side effects. No external state. No env reads. No logging.
 * Only deterministic input → output transforms for ANSI formatting,
 * number formatting, and string normalization.
 */

import {
  colorizeImportantLogKeyValue,
  highlightStandaloneHttpCodeTokens
} from '../../../utils/http-log-code-color.js';

// ---------------------------------------------------------------------------
// ANSI constants
// ---------------------------------------------------------------------------

export const ANSI_RESET = '\x1b[0m';
export const ANSI_DIM = '\x1b[90m';
export const ANSI_BOLD = '\x1b[1m';
export const ANSI_HEADER = '\x1b[38;5;252m';
export const ANSI_VR = '\x1b[38;5;208m';
export const ANSI_USAGE = '\x1b[38;5;39m';
export const ANSI_SESSION = '\x1b[38;5;141m';
export const ANSI_BAR = '\x1b[38;5;240m';
export const ANSI_WHITE = '\x1b[97m';

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

export function formatMs(value: number): string {
  return `${Math.max(0, Math.round(value))}ms`;
}

export function formatWholeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return Math.round(Math.max(0, value)).toLocaleString('en-US');
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

export function formatRatio(numerator: number, denominator: number): string {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return '0.0%';
  }
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

export function formatPerSecond(value: number, seconds: number): string {
  if (!Number.isFinite(value) || !Number.isFinite(seconds) || seconds <= 0) {
    return '0.00/s';
  }
  return `${(value / seconds).toFixed(2)}/s`;
}

// ---------------------------------------------------------------------------
// Latency computation
// ---------------------------------------------------------------------------

export function computeDecodeResidualMs(sseDecodeMs: number, codecDecodeMs: number): number {
  return Math.max(0, codecDecodeMs - sseDecodeMs);
}

export function computeCoreInternalMs(
  internalLatencyMs: number,
  trafficWaitMs: number,
  clientInjectWaitMs: number,
  sseDecodeMs: number,
  codecDecodeMs: number
): number {
  return Math.max(
    0,
    internalLatencyMs
      - trafficWaitMs
      - clientInjectWaitMs
      - computeDecodeResidualMs(sseDecodeMs, codecDecodeMs)
  );
}

// ---------------------------------------------------------------------------
// String normalization
// ---------------------------------------------------------------------------

export function normalizeLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

export function normalizeSessionId(value: unknown): string {
  if (typeof value !== 'string') {
    return 'unknown';
  }
  const trimmed = value.trim();
  return trimmed || 'unknown';
}

export function normalizeProjectPath(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function normalizeFinishReason(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

// ---------------------------------------------------------------------------
// Display formatting
// ---------------------------------------------------------------------------

export function buildKey(routeName: string, poolId: string, providerKey: string, model: string): string {
  return `${routeName}\u0000${poolId}\u0000${providerKey}\u0000${model}`;
}

export function colorize(text: string, color: string): string {
  return `${color}${text}${ANSI_RESET}`;
}

export function highlightLogKeyValues(text: string, baseColor: string): string {
  const highlightedKeyValues = text.replace(
    /(\x1b\[[0-9;]*m)?([A-Za-z][A-Za-z0-9_.]*)=([^ \x1b,)\]]+)([,\)])?/g,
    (match: string, ansiPrefix: string | undefined, key: string, value: string, suffix = '') => {
      if (ansiPrefix) {
        return match;
      }
      const httpCodeValue = colorizeImportantLogKeyValue(key, value, suffix, baseColor);
      if (httpCodeValue) {
        return httpCodeValue;
      }
      if (key !== 'finish_reason' && !/^[-+]?\d/.test(value)) {
        return `${key}=${value}${suffix}`;
      }
      return `${key}=${ANSI_WHITE}${value}${ANSI_RESET}${baseColor}${suffix}`;
    }
  );
  return highlightStandaloneHttpCodeTokens(highlightedKeyValues, baseColor);
}

export function formatRoutePool(routeName: string, poolId: string): string {
  return poolId !== '-' ? `${routeName}/${poolId}` : routeName;
}

export function formatRouteName(routeName: string): string {
  return normalizeLabel(routeName, 'route');
}

export function formatProvider(providerKey: string, model: string): string {
  return model !== '-' ? `${providerKey}.${model}` : providerKey;
}

export function formatProjectPort(projectPath: string | undefined, entryPort?: number): string {
  const project = trimPathForLog(projectPath && projectPath.trim() ? projectPath.trim() : '-', 56);
  if (typeof entryPort === 'number' && Number.isFinite(entryPort) && entryPort > 0) {
    return `${project}:${Math.floor(entryPort)}`;
  }
  return project;
}

export function shortSessionId(value: string): string {
  const normalized = normalizeSessionId(value);
  if (normalized.length <= 22) {
    return normalized;
  }
  return `${normalized.slice(0, 10)}…${normalized.slice(-8)}`;
}

export function shortRequestId(value: string): string {
  const normalized = normalizeLabel(value, 'unknown-request');
  if (normalized.length <= 12) {
    return normalized;
  }
  return `…${normalized.slice(-10)}`;
}

export function shortRequestIdTail(value: string): string {
  const normalized = normalizeLabel(value, 'unknown-request');
  if (normalized.length <= 8) {
    return normalized;
  }
  return normalized.slice(-8);
}

export function formatUsageRequestId(value: string): string {
  const normalized = normalizeLabel(value, 'unknown-request');
  const directSequence = normalized.match(/^(\d+)-(\d+)$/);
  if (directSequence) {
    return `${directSequence[1]}-${directSequence[2]}`;
  }
  const rustSequence = normalized.match(/^req_(\d+)_(\d+)$/);
  if (rustSequence) {
    return `${rustSequence[1]}-${rustSequence[2]}`;
  }
  const providerSequence = normalized.match(/-(\d+)-(\d+)(?::.*)?$/);
  if (providerSequence) {
    return `${providerSequence[1]}-${providerSequence[2]}`;
  }
  return shortRequestIdTail(normalized);
}

export function trimPathForLog(value: string, maxLen = 96): string {
  if (value.length <= maxLen) {
    return value;
  }
  const keep = Math.max(8, Math.floor((maxLen - 1) / 2));
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}
