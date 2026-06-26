/**
 * Retry Payload Snapshot Utilities
 *
 * Extracted from request-executor.ts.
 * Delegates non-blocking logging via injected callback.
 */

import { describeRetryReason } from './retry-engine.js';
import { readString } from './request-executor-error-shared.js';
import type { RetryErrorSnapshot } from './request-executor-error-types.js';
import { extractStatusCodeFromError, firstFiniteNumber } from './utils.js';
import { estimateRetryPayloadBytes } from './retry-payload-bytes-estimator.js';
import { readRuntimeDebugSnapshotProjection } from '../metadata-center/request-truth-readers.js';

type LogNonBlockingError = (stage: string, error: unknown, details?: Record<string, unknown>) => void;
let _logNB: LogNonBlockingError | undefined;

const RETRY_SNAPSHOT_PARSE_MAX_CHARS = 256 * 1024;
const RETRY_SNAPSHOT_RESTORE_MAX_CHARS = 2 * 1024 * 1024;
const RETRY_SNAPSHOT_SERIALIZE_MAX_CHARS = 256 * 1024;
const RETRY_PAYLOAD_ESTIMATE_MAX_BYTES = RETRY_SNAPSHOT_SERIALIZE_MAX_CHARS * 2;

function logNonBlockingError(stage: string, error: unknown, details?: Record<string, unknown>): void {
  _logNB?.(stage, error, details);
}

export function setRetrySnapshotLogger(log: LogNonBlockingError): void {
  _logNB = log;
}


function readStatusCodeCandidate(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{3}$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

export type HubStageTopEntry = {
  stage: string;
  totalMs: number;
  count?: number;
  avgMs?: number;
  maxMs?: number;
};

export type HubDecodeBreakdown = {
  sseDecodeMs: number;
  codecDecodeMs: number;
};

export type RetryPayloadSeed =
  | {
    mode: 'serialized';
    serializedPayload: string;
  }
  | {
    mode: 'snapshot';
    snapshotPayload: Record<string, unknown>;
  }
  | {
    mode: 'none';
  };


export function parseJsonRecordFromText(text: string): Record<string, unknown> | null {
  if (typeof text !== 'string' || !text) {
    return null;
  }
  if (text.length > RETRY_SNAPSHOT_PARSE_MAX_CHARS) {
    logNonBlockingError(
      'parseJsonRecordFromText.oversized_skip',
      new Error('candidate text too large'),
      { candidateLength: text.length, maxChars: RETRY_SNAPSHOT_PARSE_MAX_CHARS }
    );
    return null;
  }
  const normalized = text.trim();
  if (!normalized) {
    return null;
  }
  if (/^<!doctype\b/i.test(normalized) || /^<html\b/i.test(normalized)) {
    return null;
  }
  const shouldLogParseFailure = (candidate: string): boolean => {
    const trimmed = candidate.trimStart();
    if (trimmed.startsWith('{')) {
      return true;
    }
    // Only treat as JSON array candidate when '[' is followed by JSON-looking payload,
    // otherwise strings like "[servertool] xxx" should not trigger JSON parse noise.
    return /^\[\s*[\[{"]/u.test(trimmed);
  };
  const parseCandidate = (candidate: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (error) {
      if (shouldLogParseFailure(candidate)) {
        logNonBlockingError('parseJsonRecordFromText.parseCandidate', error, {
          candidateLength: candidate.length
        });
      }
      return null;
    }
    return null;
  };
  if (shouldLogParseFailure(normalized)) {
    const direct = parseCandidate(normalized);
    if (direct) {
      return direct;
    }
  }
  const firstBrace = normalized.indexOf('{');
  const lastBrace = normalized.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return null;
  }
  const prefix = normalized.slice(0, firstBrace).trim();
  if (prefix.includes('<') || /<!doctype\b|<html\b/i.test(prefix)) {
    return null;
  }
  return parseCandidate(normalized.slice(firstBrace, lastBrace + 1));
}

export function extractRetrySnapshotFromText(text: string): Partial<RetryErrorSnapshot> {
  const parsed = parseJsonRecordFromText(text);
  const parsedError =
    parsed?.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)
      ? (parsed.error as Record<string, unknown>)
      : undefined;
  const statusFromJson =
    readStatusCodeCandidate(parsedError?.status)
    ?? readStatusCodeCandidate(parsed?.status)
    ?? readStatusCodeCandidate((parsed?.response as Record<string, unknown> | undefined)?.status);
  const errorCodeFromJson =
    readString(parsedError?.code)
    ?? readString(parsed?.code)
    ?? (typeof parsedError?.code === 'number' ? String(parsedError.code) : undefined)
    ?? (typeof parsed?.code === 'number' ? String(parsed.code) : undefined);
  const upstreamCodeFromJson =
    readString(parsedError?.upstreamCode)
    ?? readString(parsedError?.upstream_code)
    ?? readString(parsed?.upstreamCode)
    ?? readString(parsed?.upstream_code)
    ?? (typeof parsedError?.upstreamCode === 'number' ? String(parsedError.upstreamCode) : undefined)
    ?? (typeof parsedError?.upstream_code === 'number' ? String(parsedError.upstream_code) : undefined)
    ?? (typeof parsed?.upstreamCode === 'number' ? String(parsed.upstreamCode) : undefined)
    ?? (typeof parsed?.upstream_code === 'number' ? String(parsed.upstream_code) : undefined);
  const reasonFromJson = readString(parsedError?.message) ?? readString(parsed?.message);

  const statusFromRegex = (() => {
    const match = text.match(/\b(?:HTTP\s+)?(\d{3})\b/i);
    if (!match) {
      return undefined;
    }
    const parsedStatus = Number.parseInt(match[1], 10);
    return Number.isFinite(parsedStatus) ? parsedStatus : undefined;
  })();
  const errorCodeFromRegex =
    text.match(/"code"\s*:\s*"([^"]+)"/i)?.[1]
    ?? text.match(/\bcode[=:]\s*([A-Za-z0-9_.-]+)/i)?.[1];
  const upstreamCodeFromRegex =
    text.match(/"upstream(?:_code|Code)"\s*:\s*"([^"]+)"/i)?.[1]
    ?? text.match(/\bupstream(?:_code|Code)[=:]\s*([A-Za-z0-9_.-]+)/i)?.[1];

  return {
    ...(typeof statusFromJson === 'number'
      ? { statusCode: statusFromJson }
      : (typeof statusFromRegex === 'number' ? { statusCode: statusFromRegex } : {})),
    ...(errorCodeFromJson ? { errorCode: errorCodeFromJson } : (errorCodeFromRegex ? { errorCode: errorCodeFromRegex } : {})),
    ...(upstreamCodeFromJson
      ? { upstreamCode: upstreamCodeFromJson }
      : (upstreamCodeFromRegex ? { upstreamCode: upstreamCodeFromRegex } : {})),
    ...(reasonFromJson ? { reason: reasonFromJson } : {})
  };
}

export function extractRetryErrorSnapshot(error: unknown): RetryErrorSnapshot {
  const fallbackReason = 'Unknown error';
  if (!error || typeof error !== 'object') {
    return {
      reason: describeRetryReason(error) || fallbackReason
    };
  }
  const record = error as Record<string, unknown>;
  const responseData = (record.response as { data?: unknown } | undefined)?.data;
  const responseError =
    responseData && typeof responseData === 'object'
      ? (responseData as Record<string, unknown>).error
      : undefined;
  const responseErrorRecord =
    responseError && typeof responseError === 'object'
      ? (responseError as Record<string, unknown>)
      : undefined;
  const responseDataRecord =
    responseData && typeof responseData === 'object' && !Array.isArray(responseData)
      ? (responseData as Record<string, unknown>)
      : undefined;
  const detailsRecord =
    record.details && typeof record.details === 'object'
      ? (record.details as Record<string, unknown>)
      : undefined;

  const statusCode = extractStatusCodeFromError(error);
  const errorCode =
    readString(record.code)
    ?? readString(record.errorCode)
    ?? readString(detailsRecord?.code)
    ?? readString(responseErrorRecord?.code);
  const upstreamCode =
    readString(record.upstreamCode)
    ?? readString(detailsRecord?.upstreamCode)
    ?? readString(detailsRecord?.upstream_code);
  const upstreamStatus = firstFiniteNumber([
    record.upstreamStatus,
    record.upstream_status,
    detailsRecord?.upstreamStatus,
    detailsRecord?.upstream_status,
  ]);
  const textDerived = [
    readString(record.rawErrorSnippet),
    readString(record.rawError),
    readString(record.message),
    readString(responseData),
    readString(responseDataRecord?.error),
    readString(detailsRecord?.rawError),
    readString(detailsRecord?.rawErrorSnippet)
  ]
    .filter((value): value is string => Boolean(value))
    .map(extractRetrySnapshotFromText);
  const mergedTextDerived = textDerived.reduce<Partial<RetryErrorSnapshot>>(
    (acc, next) => ({ ...acc, ...next }),
    {}
  );
  const reason =
    mergedTextDerived.reason
    ?? describeRetryReason(error)
    ?? fallbackReason;

  return {
    ...(typeof statusCode === 'number'
      ? { statusCode }
      : (typeof mergedTextDerived.statusCode === 'number' ? { statusCode: mergedTextDerived.statusCode } : {})),
    ...(errorCode ? { errorCode } : (mergedTextDerived.errorCode ? { errorCode: mergedTextDerived.errorCode } : {})),
    ...(upstreamCode ? { upstreamCode } : (mergedTextDerived.upstreamCode ? { upstreamCode: mergedTextDerived.upstreamCode } : {})),
    ...(typeof upstreamStatus === 'number' ? { upstreamStatus } : {}),
    reason
  };
}

export function readHubStageTop(metadata: Record<string, unknown> | undefined): HubStageTopEntry[] | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const raw = readRuntimeDebugSnapshotProjection(metadata).hubStageTop;
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const normalized = raw
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const stage = typeof record.stage === 'string' ? record.stage.trim() : '';
      const totalMs =
        typeof record.totalMs === 'number' && Number.isFinite(record.totalMs)
          ? Math.max(0, Math.round(record.totalMs))
          : undefined;
      if (!stage || totalMs === undefined) {
        return null;
      }
      const count =
        typeof record.count === 'number' && Number.isFinite(record.count)
          ? Math.max(0, Math.floor(record.count))
          : undefined;
      const avgMs =
        typeof record.avgMs === 'number' && Number.isFinite(record.avgMs)
          ? Math.max(0, Math.round(record.avgMs))
          : undefined;
      const maxMs =
        typeof record.maxMs === 'number' && Number.isFinite(record.maxMs)
          ? Math.max(0, Math.round(record.maxMs))
          : undefined;
      return {
        stage,
        totalMs,
        ...(count !== undefined ? { count } : {}),
        ...(avgMs !== undefined ? { avgMs } : {}),
        ...(maxMs !== undefined ? { maxMs } : {})
      } as HubStageTopEntry;
    })
    .filter((entry): entry is HubStageTopEntry => Boolean(entry));
  return normalized.length ? normalized : undefined;
}

export function readHubDecodeBreakdown(hubStageTop: HubStageTopEntry[] | undefined): HubDecodeBreakdown {
  if (!Array.isArray(hubStageTop) || hubStageTop.length === 0) {
    return { sseDecodeMs: 0, codecDecodeMs: 0 };
  }
  let sseDecodeMs = 0;
  let codecDecodeMs = 0;
  for (const entry of hubStageTop) {
    const stage = String(entry.stage || '').trim().toLowerCase();
    const totalMs = Number.isFinite(entry.totalMs) ? Math.max(0, Math.round(entry.totalMs)) : 0;
    if (!(totalMs > 0) || !stage) {
      continue;
    }
    // `resp_inbound.stage1_codec_decode` reflects the wall-clock spent consuming upstream SSE until
    // the terminal event arrives, so it belongs to upstream/decode waiting rather than host core
    // internal time. Keep wrapper/text probes out of decode accounting; only the explicit stream
    // decode stage contributes here.
    if (stage.includes('stage1_codec_decode')) {
      sseDecodeMs += totalMs;
      codecDecodeMs += totalMs;
    }
  }
  return { sseDecodeMs, codecDecodeMs };
}

export function serializeRequestPayloadForRetry(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  try {
    return JSON.stringify(payload);
  } catch (error) {
    logNonBlockingError('serializeRequestPayloadForRetry', error);
    return undefined;
  }
}

export function cloneRequestPayloadForRetry(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  try {
    const cloned = structuredClone(payload) as unknown;
    if (cloned && typeof cloned === 'object' && !Array.isArray(cloned)) {
      return cloned as Record<string, unknown>;
    }
  } catch (error) {
    logNonBlockingError('cloneRequestPayloadForRetry.structuredClone', error);
  }
  return undefined;
}

export function prepareRequestPayloadRetrySeed(payload: unknown): RetryPayloadSeed {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { mode: 'none' };
  }

  const estimatedBytes = estimateRetryPayloadBytes(payload, {
    maxBytes: RETRY_PAYLOAD_ESTIMATE_MAX_BYTES + 1
  });
  if (estimatedBytes <= RETRY_PAYLOAD_ESTIMATE_MAX_BYTES) {
    const serializedPayload = serializeRequestPayloadForRetry(payload);
    if (
      typeof serializedPayload === 'string'
      && serializedPayload.length <= RETRY_SNAPSHOT_SERIALIZE_MAX_CHARS
    ) {
      return {
        mode: 'serialized',
        serializedPayload
      };
    }
  }

  const snapshotPayload = cloneRequestPayloadForRetry(payload);
  if (snapshotPayload) {
    return {
      mode: 'snapshot',
      snapshotPayload
    };
  }

  const serializedPayload = serializeRequestPayloadForRetry(payload);
  if (
    typeof serializedPayload === 'string'
    && serializedPayload.length <= RETRY_SNAPSHOT_SERIALIZE_MAX_CHARS
  ) {
    return {
      mode: 'serialized',
      serializedPayload
    };
  }

  return { mode: 'none' };
}

export function restoreRequestPayloadFromRetrySeed(seed: RetryPayloadSeed): Record<string, unknown> | undefined {
  if (seed.mode === 'serialized') {
    return restoreRequestPayloadFromRetrySnapshot(seed.serializedPayload);
  }
  if (seed.mode === 'snapshot') {
    return cloneRequestPayloadForRetry(seed.snapshotPayload) ?? { ...seed.snapshotPayload };
  }
  return undefined;
}

export function resolveOriginalRequestForResponseConversion(seed: RetryPayloadSeed): Record<string, unknown> | undefined {
  if (seed.mode === 'snapshot') {
    return seed.snapshotPayload;
  }
  return restoreRequestPayloadFromRetrySeed(seed);
}

export function restoreRequestPayloadFromRetrySnapshot(
  serializedPayload?: string,
  fallbackPayload?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (serializedPayload && typeof serializedPayload === 'string') {
    if (serializedPayload.length > RETRY_SNAPSHOT_RESTORE_MAX_CHARS) {
      logNonBlockingError(
        'restoreRequestPayloadFromRetrySnapshot.oversized_skip',
        'serialized retry payload too large',
        { payloadLength: serializedPayload.length, maxChars: RETRY_SNAPSHOT_RESTORE_MAX_CHARS }
      );
    } else {
    try {
      const parsed = JSON.parse(serializedPayload) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (error) {
      logNonBlockingError('restoreRequestPayloadFromRetrySnapshot.parseSerialized', error, {
        payloadLength: serializedPayload.length
      });
    }
    }
  }
  if (!fallbackPayload || typeof fallbackPayload !== 'object') {
    return undefined;
  }
  const clonedFallback = cloneRequestPayloadForRetry(fallbackPayload);
  if (clonedFallback && typeof clonedFallback === 'object') {
    return clonedFallback;
  }
  return { ...fallbackPayload };
}

export function resetRetrySnapshotStateForTests(): void {
  _logNB = undefined;
}

export { estimateRetryPayloadBytes } from './retry-payload-bytes-estimator.js';
