import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { PipelineExecutionInput, PipelineExecutionResult } from '../../handlers/types.js';
import type { HubPipeline, ProviderHandle, ProviderProtocol } from './types.js';
import type { ProviderRuntimeProfile } from '../../../providers/core/api/provider-types.js';
import { attachProviderRuntimeMetadata } from '../../../providers/core/runtime/provider-runtime-metadata.js';
import type { StatsManager } from './stats-manager.js';
import {
  buildRequestMetadata,
  cloneClientHeaders,
  decorateMetadataForAttempt,
  ensureClientHeadersOnPayload,
  resolveClientRequestId
} from './executor-metadata.js';
import {
  type ConvertProviderResponseOptions,
  convertProviderResponseIfNeeded as convertProviderResponseWithBridge
} from './executor/provider-response-converter.js';
import { ensureHubPipeline, runHubPipeline } from './executor-pipeline.js';

// Import from new executor submodules
import {
  isVerboseErrorLoggingEnabled
} from './executor/env-config.js';
import {
  resolveMaxProviderAttempts,
  describeRetryReason,
  isPromptTooLongError,
  shouldRetryProviderError,
  waitBeforeRetry
} from './executor/retry-engine.js';
import {
  type SseWrapperErrorInfo
} from './executor/sse-error-handler.js';
import {
  type UsageMetrics,
  extractUsageFromResult,
  mergeUsageMetrics
} from './executor/usage-aggregator.js';
import {
  type AntigravityRetrySignal,
  bindSessionConversationSession,
  extractRetryErrorSignature,
  extractStatusCodeFromError,
  injectAntigravityRetrySignal,
  isAntigravityProviderKey,
  isAntigravityReauthRequired403,
  isGoogleAccountVerificationRequiredError,
  isSseDecodeRetryableNetworkError,
  isSseDecodeRateLimitError,
  resolveAntigravityMaxProviderAttempts,
  shouldRotateAntigravityAliasOnRetry
} from './executor/request-retry-helpers.js';
import {
  extractProviderModel,
  extractResponseStatus,
  normalizeProviderResponse,
  resolveRequestSemantics
} from './executor/provider-response-utils.js';
import {
  isPoolExhaustedPipelineError,
  mergeMetadataPreservingDefined,
  resolvePoolCooldownWaitMs,
  writeInboundClientSnapshot
} from './executor/request-executor-core-utils.js';
import { resolveProviderRuntimeOrThrow } from './executor/provider-runtime-resolver.js';
import { resolveProviderRequestContext } from './executor/provider-request-context.js';
import { isServerToolEnabled } from './servertool-admin-state.js';
import { registerRequestLogContext } from '../../utils/request-log-color.js';
import { deriveFinishReason, STREAM_LOG_FINISH_REASON_KEY } from '../../utils/finish-reason.js';
import {
  createNoopProviderTrafficGovernor,
  getSharedProviderTrafficGovernor,
  type ProviderTrafficGovernorLike,
  type ProviderTrafficPermit
} from './provider-traffic-governor.js';
import { recordVirtualRouterHitRollup } from './executor/log-rollup.js';
export type RequestExecutorDeps = {
  runtimeManager: {
    resolveRuntimeKey(providerKey?: string, fallback?: string): string | undefined;
    getHandleByRuntimeKey(runtimeKey?: string): ProviderHandle | undefined;
  };
  getHubPipeline(): HubPipeline | null;
  getModuleDependencies(): ModuleDependencies;
  logStage(stage: string, requestId: string, details?: Record<string, unknown>): void;
  stats: StatsManager;
  trafficGovernor?: ProviderTrafficGovernorLike;
  onRequestStart?: (args: { requestId: string; metadata: Record<string, unknown> }) => void | Promise<void>;
  onRequestEnd?: (args: { requestId: string }) => void | Promise<void>;
};

export interface RequestExecutor {
  execute(input: PipelineExecutionInput): Promise<PipelineExecutionResult>;
}

const DEFAULT_MAX_PROVIDER_ATTEMPTS = 6;
const NON_BLOCKING_LOG_THROTTLE_MS = 60_000;
const nonBlockingLogState = new Map<string, number>();
const RECOVERABLE_BACKOFF_TTL_MS = 5 * 60_000;
const recoverableErrorBackoffState = new Map<string, { consecutive: number; updatedAtMs: number }>();
const recoverableRetryGateState = new Map<string, Promise<void>>();
const PROVIDER_SWITCH_LOG_THROTTLE_MS = 5_000;
const providerSwitchLogState = new Map<string, { lastAtMs: number; suppressed: number }>();
const RETRY_SNAPSHOT_PARSE_MAX_CHARS = 256 * 1024;
const RETRY_SNAPSHOT_RESTORE_MAX_CHARS = 2 * 1024 * 1024;
// Re-export for backward compatibility
export type { SseWrapperErrorInfo };

type RetryErrorSnapshot = {
  statusCode?: number;
  errorCode?: string;
  upstreamCode?: string;
  reason: string;
};

type HubStageTopEntry = {
  stage: string;
  totalMs: number;
  count?: number;
  avgMs?: number;
  maxMs?: number;
};

type HubDecodeBreakdown = {
  sseDecodeMs: number;
  codecDecodeMs: number;
};

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

function logRequestExecutorNonBlockingError(stage: string, error: unknown, details?: Record<string, unknown>): void {
  const now = Date.now();
  const last = nonBlockingLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingLogState.set(stage, now);
  try {
    const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[request-executor] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`);
  } catch {
    // Never throw from non-blocking logging.
  }
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
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

function parseJsonRecordFromText(text: string): Record<string, unknown> | null {
  if (typeof text !== 'string' || !text) {
    return null;
  }
  if (text.length > RETRY_SNAPSHOT_PARSE_MAX_CHARS) {
    logRequestExecutorNonBlockingError(
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
        logRequestExecutorNonBlockingError('parseJsonRecordFromText.parseCandidate', error, {
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
  return parseCandidate(normalized.slice(firstBrace, lastBrace + 1));
}

function extractRetrySnapshotFromText(text: string): Partial<RetryErrorSnapshot> {
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

function extractRetryErrorSnapshot(error: unknown): RetryErrorSnapshot {
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
    reason
  };
}

function readHubStageTop(metadata: Record<string, unknown> | undefined): HubStageTopEntry[] | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const rt =
    metadata.__rt && typeof metadata.__rt === 'object' && !Array.isArray(metadata.__rt)
      ? (metadata.__rt as Record<string, unknown>)
      : undefined;
  const raw = rt?.hubStageTop;
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

function readHubDecodeBreakdown(hubStageTop: HubStageTopEntry[] | undefined): HubDecodeBreakdown {
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
    if (stage.includes('sse_decode')) {
      sseDecodeMs += totalMs;
    }
    if (stage.includes('codec_decode')) {
      codecDecodeMs += totalMs;
    }
  }
  return { sseDecodeMs, codecDecodeMs };
}

function serializeRequestPayloadForRetry(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  try {
    return JSON.stringify(payload);
  } catch (error) {
    logRequestExecutorNonBlockingError('serializeRequestPayloadForRetry', error);
    return undefined;
  }
}

function restoreRequestPayloadFromRetrySnapshot(
  serializedPayload?: string,
  fallbackPayload?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (serializedPayload && typeof serializedPayload === 'string') {
    if (serializedPayload.length > RETRY_SNAPSHOT_RESTORE_MAX_CHARS) {
      logRequestExecutorNonBlockingError(
        'restoreRequestPayloadFromRetrySnapshot.oversized_skip',
        new Error('serialized retry payload too large'),
        { payloadLength: serializedPayload.length, maxChars: RETRY_SNAPSHOT_RESTORE_MAX_CHARS }
      );
    } else {
    try {
      const parsed = JSON.parse(serializedPayload) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (error) {
      logRequestExecutorNonBlockingError('restoreRequestPayloadFromRetrySnapshot.parseSerialized', error, {
        payloadLength: serializedPayload.length
      });
    }
    }
  }
  if (!fallbackPayload || typeof fallbackPayload !== 'object') {
    return undefined;
  }
  return { ...fallbackPayload };
}

function truncateReason(reason: string, maxLength = 220): string {
  if (reason.length <= maxLength) {
    return reason;
  }
  return `${reason.slice(0, Math.max(0, maxLength - 1))}…`;
}

function normalizeCodeKey(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  return normalized || undefined;
}

function isBlockingRecoverableRetryError(args: {
  statusCode?: number;
  errorCode?: string;
  upstreamCode?: string;
  reason?: string;
}): boolean {
  const status = typeof args.statusCode === 'number' ? args.statusCode : undefined;
  const errorCode = normalizeCodeKey(args.errorCode);
  const upstreamCode = normalizeCodeKey(args.upstreamCode);
  const reason = typeof args.reason === 'string' ? args.reason.trim().toLowerCase() : '';
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  if (
    errorCode === 'PROVIDER_TRAFFIC_SATURATED'
    || errorCode === 'HTTP_429'
    || errorCode === 'HTTP_502'
    || errorCode === 'HTTP_503'
    || errorCode === 'HTTP_504'
    || errorCode === 'SSE_TO_JSON_ERROR'
    || errorCode === 'SSE_DECODE_ERROR'
    || errorCode === 'SERVERTOOL_FOLLOWUP_FAILED'
    || errorCode === 'SERVERTOOL_EMPTY_FOLLOWUP'
    || (typeof errorCode === 'string' && errorCode.startsWith('SERVERTOOL_'))
  ) {
    return true;
  }
  if (
    upstreamCode === 'HTTP_429'
    || upstreamCode === 'HTTP_502'
    || upstreamCode === 'HTTP_503'
    || upstreamCode === 'HTTP_504'
    || upstreamCode === 'SSE_TO_JSON_ERROR'
    || upstreamCode === 'SSE_DECODE_ERROR'
  ) {
    return true;
  }
  if (
    reason.includes('fetch failed')
    || reason.includes('building not completed')
    || reason.includes('network')
    || reason.includes('timeout')
    || reason.includes('temporarily unavailable')
  ) {
    return true;
  }
  return false;
}

function shouldBlockRetryOnCurrentProvider(args: {
  statusCode?: number;
  errorCode?: string;
  upstreamCode?: string;
  reason?: string;
}): boolean {
  return isBlockingRecoverableRetryError(args);
}

function buildRecoverableErrorBackoffKey(args: {
  statusCode?: number;
  errorCode?: string;
  upstreamCode?: string;
  reason?: string;
}): string {
  const statusPart = typeof args.statusCode === 'number' ? `status:${args.statusCode}` : 'status:none';
  const errorPart = normalizeCodeKey(args.errorCode) ?? 'error:none';
  const upstreamPart = normalizeCodeKey(args.upstreamCode) ?? 'upstream:none';
  const reasonPart = (() => {
    if (typeof args.reason !== 'string') {
      return 'reason:none';
    }
    const normalized = args.reason.trim().toLowerCase();
    if (!normalized) {
      return 'reason:none';
    }
    if (normalized.includes('fetch failed')) return 'reason:fetch_failed';
    if (normalized.includes('building not completed')) return 'reason:building_not_completed';
    if (normalized.includes('network')) return 'reason:network';
    if (normalized.includes('timeout')) return 'reason:timeout';
    return 'reason:other';
  })();
  return `${statusPart}|${errorPart}|${upstreamPart}|${reasonPart}`;
}

function consumeRecoverableErrorBackoffMs(key: string): number {
  const now = Date.now();
  for (const [existingKey, state] of recoverableErrorBackoffState.entries()) {
    if (now - state.updatedAtMs >= RECOVERABLE_BACKOFF_TTL_MS) {
      recoverableErrorBackoffState.delete(existingKey);
    }
  }
  const previous = recoverableErrorBackoffState.get(key);
  const consecutive =
    previous && now - previous.updatedAtMs < RECOVERABLE_BACKOFF_TTL_MS
      ? Math.min(previous.consecutive + 1, 16)
      : 1;
  recoverableErrorBackoffState.set(key, {
    consecutive,
    updatedAtMs: now
  });
  const baseMs = (() => {
    const raw = process.env.ROUTECODEX_RECOVERABLE_BACKOFF_BASE_MS || process.env.RCC_RECOVERABLE_BACKOFF_BASE_MS;
    const parsed = raw ? Number.parseInt(String(raw).trim(), 10) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    return process.env.NODE_ENV === 'test' ? 200 : 1_000;
  })();
  const maxMs = (() => {
    const raw = process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_MS || process.env.RCC_RECOVERABLE_BACKOFF_MAX_MS;
    const parsed = raw ? Number.parseInt(String(raw).trim(), 10) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    return process.env.NODE_ENV === 'test' ? 5_000 : 120_000;
  })();
  return Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, consecutive - 1)));
}

async function waitRecoverableBackoffMs(ms: number): Promise<void> {
  if (!(ms > 0)) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitRecoverableBackoffWithGlobalGate(key: string, ms: number): Promise<void> {
  const normalizedKey = key.trim() || 'recoverable:unknown';
  const previous = recoverableRetryGateState.get(normalizedKey) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  recoverableRetryGateState.set(normalizedKey, current);
  await previous.catch(() => undefined);
  try {
    await waitRecoverableBackoffMs(ms);
  } finally {
    release();
    if (recoverableRetryGateState.get(normalizedKey) === current) {
      recoverableRetryGateState.delete(normalizedKey);
    }
  }
}

function resolveTrafficRuntimeProfile(
  runtimeKey: string,
  handle: ProviderHandle,
  providerKey?: string
): ProviderRuntimeProfile {
  const runtimeCandidate = handle.runtime as ProviderRuntimeProfile | undefined;
  if (runtimeCandidate && typeof runtimeCandidate === 'object') {
    return runtimeCandidate;
  }
  const providerIdFallback = (() => {
    if (typeof handle.providerId === 'string' && handle.providerId.trim()) {
      return handle.providerId.trim();
    }
    if (typeof providerKey === 'string' && providerKey.includes('.')) {
      const [head] = providerKey.split('.');
      if (head && head.trim()) {
        return head.trim();
      }
    }
    return 'unknown';
  })();
  const providerTypeFallback = (
    typeof handle.providerType === 'string' && handle.providerType.trim()
      ? handle.providerType.trim().toLowerCase()
      : 'openai'
  ) as ProviderRuntimeProfile['providerType'];
  return {
    runtimeKey,
    providerId: providerIdFallback,
    providerKey,
    providerType: providerTypeFallback,
    providerFamily: handle.providerFamily,
    endpoint: '',
    auth: {
      type: 'apikey',
      value: ''
    }
  };
}

function normalizeRuntimeKey(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function resolveRuntimeKeyForProvider(
  runtimeManager: RequestExecutorDeps['runtimeManager'],
  providerKey: string
): string | undefined {
  return normalizeRuntimeKey(runtimeManager.resolveRuntimeKey(providerKey));
}

function routePoolHasAlternativeProvider(args: {
  routePool: string[];
  excludedProviderKeys: Set<string>;
  currentProviderKey?: string;
}): boolean {
  const currentProviderKey =
    typeof args.currentProviderKey === 'string' && args.currentProviderKey.trim()
      ? args.currentProviderKey.trim()
      : undefined;
  for (const providerKey of args.routePool) {
    if (typeof providerKey !== 'string') {
      continue;
    }
    const normalizedProviderKey = providerKey.trim();
    if (!normalizedProviderKey) {
      continue;
    }
    if (currentProviderKey && normalizedProviderKey === currentProviderKey) {
      continue;
    }
    if (args.excludedProviderKeys.has(normalizedProviderKey)) {
      continue;
    }
    return true;
  }
  return false;
}

function excludeProvidersSharingRuntimeFromRoutePool(args: {
  routePool: string[];
  runtimeKey: string;
  runtimeManager: RequestExecutorDeps['runtimeManager'];
  excludedProviderKeys: Set<string>;
}): string[] {
  const currentRuntimeKey = normalizeRuntimeKey(args.runtimeKey);
  if (!currentRuntimeKey) {
    return [];
  }
  const added: string[] = [];
  for (const providerKey of args.routePool) {
    if (typeof providerKey !== 'string') {
      continue;
    }
    const normalizedProviderKey = providerKey.trim();
    if (!normalizedProviderKey) {
      continue;
    }
    const candidateRuntimeKey = resolveRuntimeKeyForProvider(args.runtimeManager, normalizedProviderKey);
    if (candidateRuntimeKey !== currentRuntimeKey) {
      continue;
    }
    if (args.excludedProviderKeys.has(normalizedProviderKey)) {
      continue;
    }
    args.excludedProviderKeys.add(normalizedProviderKey);
    added.push(normalizedProviderKey);
  }
  return added;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valueHasNonEmptyText(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.some((item) => valueHasNonEmptyText(item));
  }
  if (!isRecord(value)) {
    return false;
  }
  return (
    valueHasNonEmptyText(value.text)
    || valueHasNonEmptyText(value.output_text)
    || valueHasNonEmptyText(value.content)
    || valueHasNonEmptyText(value.reasoning_content)
    || valueHasNonEmptyText(value.reasoning)
  );
}

function extractTextFromResponsesOutputItem(item: unknown): string {
  if (!isRecord(item)) {
    return '';
  }
  const itemType = readString(item.type)?.toLowerCase();
  if (itemType === 'output_text' || itemType === 'text' || itemType === 'input_text') {
    const direct = readString(item.text);
    if (direct) {
      return direct;
    }
  }
  if (itemType === 'message') {
    const content = Array.isArray(item.content) ? item.content : [];
    const chunks: string[] = [];
    for (const part of content) {
      if (!isRecord(part)) {
        continue;
      }
      const partType = readString(part.type)?.toLowerCase();
      if (partType && partType !== 'output_text' && partType !== 'text' && partType !== 'input_text') {
        continue;
      }
      const partText = readString(part.text);
      if (partText) {
        chunks.push(partText);
      }
    }
    return chunks.join('');
  }
  return '';
}

function backfillResponsesOutputTextIfMissing(body: unknown): void {
  if (!isRecord(body)) {
    return;
  }
  if (valueHasNonEmptyText(body.output_text)) {
    return;
  }
  const outputItems = Array.isArray(body.output) ? body.output : [];
  if (outputItems.length <= 0) {
    return;
  }
  const text = outputItems
    .map((item) => extractTextFromResponsesOutputItem(item))
    .join('')
    .trim();
  if (!text) {
    return;
  }
  body.output_text = text;
}

function emitVirtualRouterConcurrencyLog(args: {
  sessionId?: string;
  projectPath?: string;
  routeName?: string;
  poolId?: string;
  providerKey?: string;
  model?: string;
  reason?: string;
  activeInFlight: number;
  maxInFlight: number;
}): void {
  void args.reason;
  recordVirtualRouterHitRollup({
    routeName: args.routeName,
    poolId: args.poolId,
    providerKey: args.providerKey,
    model: args.model,
    sessionId: args.sessionId,
    projectPath: args.projectPath,
    activeInFlight: args.activeInFlight,
    maxInFlight: args.maxInFlight
  });
}

function hasNonEmptyToolCalls(value: unknown): boolean {
  if (!Array.isArray(value) || value.length <= 0) {
    return false;
  }
  return value.some((item) => isRecord(item));
}

function hasOutputFunctionCalls(value: unknown): boolean {
  if (!Array.isArray(value) || value.length <= 0) {
    return false;
  }
  return value.some((item) => {
    if (!isRecord(item)) {
      return false;
    }
    const itemType = readString(item.type)?.toLowerCase();
    if (itemType === 'function_call' || itemType === 'function') {
      return true;
    }
    if (hasNonEmptyToolCalls(item.tool_calls)) {
      return true;
    }
    return false;
  });
}

function containsToolRegistryMissingText(value: unknown): boolean {
  if (!valueHasNonEmptyText(value)) {
    return false;
  }
  const text = String(value ?? '');
  const pattern = /tool\s+[a-z0-9_.-]+\s+does\s+not\s+exist(?:s)?/ig;
  let count = 0;
  while (pattern.exec(text)) {
    count += 1;
    if (count >= 1) {
      return true;
    }
  }
  return false;
}

function detectRetryableEmptyAssistantResponse(body: unknown): { reason: string; marker: string } | null {
  if (!isRecord(body)) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(body, '__sse_responses')) {
    return null;
  }

  const choices = Array.isArray(body.choices) ? body.choices : [];
  if (choices.length > 0) {
    const firstChoice = isRecord(choices[0]) ? choices[0] : undefined;
    if (!firstChoice) {
      return null;
    }
    const finishReason = readString(firstChoice.finish_reason)?.toLowerCase() ?? '';
    const message = isRecord(firstChoice.message) ? firstChoice.message : undefined;
    const hasToolCalls = hasNonEmptyToolCalls(message?.tool_calls);
    const hasText =
      valueHasNonEmptyText(message?.content)
      || valueHasNonEmptyText(message?.reasoning_content)
      || valueHasNonEmptyText(message?.reasoning)
      || valueHasNonEmptyText(firstChoice.content);
    const combinedText = [
      message?.content,
      message?.reasoning_content,
      message?.reasoning,
      firstChoice.content
    ]
      .filter((item) => valueHasNonEmptyText(item))
      .map((item) => String(item))
      .join('\n');
    if ((finishReason === 'stop' || finishReason === 'tool_calls' || !finishReason) && !hasToolCalls && !hasText) {
      return {
        reason: `finish_reason=${finishReason || 'unknown'} but assistant text/tool_calls are empty`,
        marker: 'chat_empty_assistant'
      };
    }
    if ((finishReason === 'stop' || finishReason === 'tool_calls' || !finishReason) && !hasToolCalls && containsToolRegistryMissingText(combinedText)) {
      return {
        reason: 'assistant emitted textual tool-not-found complaint without structured tool_calls',
        marker: 'chat_textual_tool_registry_missing'
      };
    }
  }

  const status = readString(body.status)?.toLowerCase() ?? '';
  if (status === 'completed' || status === 'stop') {
    const requiredAction = isRecord(body.required_action) ? body.required_action : undefined;
    const submitToolOutputs =
      requiredAction && isRecord(requiredAction.submit_tool_outputs)
        ? requiredAction.submit_tool_outputs
        : undefined;
    const hasRequiredActionToolCalls = hasNonEmptyToolCalls(submitToolOutputs?.tool_calls);
    const hasFunctionCalls = hasOutputFunctionCalls(body.output);
    const hasText =
      valueHasNonEmptyText(body.output_text)
      || valueHasNonEmptyText(body.output)
      || valueHasNonEmptyText(body.reasoning);
    if (!hasRequiredActionToolCalls && !hasFunctionCalls && !hasText) {
      return {
        reason: `responses status=${status} but output text/tool_calls are empty`,
        marker: 'responses_empty_output'
      };
    }
    if (
      !hasRequiredActionToolCalls &&
      !hasFunctionCalls &&
      containsToolRegistryMissingText(body.output_text)
    ) {
      return {
        reason: 'responses completed with textual tool-not-found complaint but no function_call output',
        marker: 'responses_textual_tool_registry_missing'
      };
    }
  }

  return null;
}

export class HubRequestExecutor implements RequestExecutor {
  private readonly trafficGovernor: ProviderTrafficGovernorLike;

  constructor(private readonly deps: RequestExecutorDeps) {
    if (deps.trafficGovernor) {
      this.trafficGovernor = deps.trafficGovernor;
      return;
    }
    if (process.env.NODE_ENV === 'test') {
      this.trafficGovernor = createNoopProviderTrafficGovernor();
      return;
    }
    const disableTrafficGovernor =
      process.env.ROUTECODEX_PROVIDER_TRAFFIC_NOOP === '1'
      || process.env.RCC_PROVIDER_TRAFFIC_NOOP === '1';
    if (disableTrafficGovernor) {
      this.trafficGovernor = createNoopProviderTrafficGovernor();
      return;
    }
    this.trafficGovernor = getSharedProviderTrafficGovernor();
  }

  private logProviderRetrySwitch(args: {
    requestId: string;
    attempt: number;
    maxAttempts: number;
    providerKey?: string;
    nextAttempt: number;
    reason: string;
    backoffMs?: number;
    statusCode?: number;
    errorCode?: string;
    upstreamCode?: string;
    switchAction: 'exclude_and_reroute' | 'retry_same_provider';
  }): void {
    const now = Date.now();
    const providerLabel = args.providerKey || 'unknown-provider';
    const dedupeKey = [
      providerLabel,
      args.switchAction,
      typeof args.statusCode === 'number' ? String(args.statusCode) : 'none',
      args.errorCode || 'none',
      args.upstreamCode || 'none',
      truncateReason(args.reason, 96)
    ].join('|');
    const prior = providerSwitchLogState.get(dedupeKey);
    if (prior && now - prior.lastAtMs < PROVIDER_SWITCH_LOG_THROTTLE_MS) {
      prior.suppressed += 1;
      prior.lastAtMs = now;
      providerSwitchLogState.set(dedupeKey, prior);
      return;
    }
    if (prior?.suppressed && prior.suppressed > 0) {
      console.warn(
        `[provider-switch] aggregated key=${JSON.stringify(dedupeKey)} suppressed=${prior.suppressed} ` +
          `windowMs=${PROVIDER_SWITCH_LOG_THROTTLE_MS}`
      );
    }
    providerSwitchLogState.set(dedupeKey, { lastAtMs: now, suppressed: 0 });
    const retryTag = `[provider-switch] req=${args.requestId} attempt=${args.attempt}/${args.maxAttempts} -> ${args.nextAttempt}/${args.maxAttempts}`;
    const details = [
      `provider=${providerLabel}`,
      `switch=${args.switchAction}`,
      ...(typeof args.statusCode === 'number' ? [`status=${args.statusCode}`] : []),
      ...(args.errorCode ? [`code=${args.errorCode}`] : []),
      ...(args.upstreamCode ? [`upstreamCode=${args.upstreamCode}`] : []),
      ...(typeof args.backoffMs === 'number' ? [`backoff=${Math.max(0, Math.round(args.backoffMs))}ms`] : []),
      `reason=${JSON.stringify(truncateReason(args.reason))}`
    ];
    console.warn(`${retryTag} ${details.join(' ')}`);
  }

  async execute(input: PipelineExecutionInput): Promise<PipelineExecutionResult> {
    // Stats must remain stable across provider retries and requestId enhancements.
    const statsRequestId = input.requestId;
    const executorRequestId = input.requestId;
    this.deps.stats.recordRequestStart(statsRequestId);
    const requestStartedAt = Date.now();
    let recordedAnyAttempt = false;
    const recordAttempt = (options?: { usage?: UsageMetrics; error?: boolean }) => {
      this.deps.stats.recordCompletion(statsRequestId, options);
      recordedAnyAttempt = true;
    };
    try {
      const hubPipeline = ensureHubPipeline(this.deps.getHubPipeline);
      const initialMetadata = buildRequestMetadata(input);
      await this.deps.onRequestStart?.({ requestId: executorRequestId, metadata: initialMetadata });
      try {
        bindSessionConversationSession(initialMetadata);
        registerRequestLogContext(input.requestId, {
          sessionId: initialMetadata.sessionId,
          conversationId: initialMetadata.conversationId
        });
        const inboundClientHeaders = cloneClientHeaders(initialMetadata?.clientHeaders);
        const providerRequestId = input.requestId;
        const clientRequestId = resolveClientRequestId(initialMetadata, providerRequestId);

        this.logStage('request.received', providerRequestId, {
          endpoint: input.entryEndpoint,
          stream: initialMetadata.stream === true
        });

        this.logStage('request.snapshot.start', providerRequestId, {
          endpoint: input.entryEndpoint
        });
        await writeInboundClientSnapshot({ input, initialMetadata, clientRequestId });
        this.logStage('request.snapshot.completed', providerRequestId, {
          endpoint: input.entryEndpoint
        });

        const pipelineLabel = 'hub';
        let aggregatedUsage: UsageMetrics | undefined;
        const excludedProviderKeys = new Set<string>();
        let maxAttempts = resolveMaxProviderAttempts();
        const originalRequestSnapshot = restoreRequestPayloadFromRetrySnapshot(
          serializeRequestPayloadForRetry(input.body)
        );
        const originalRequestSnapshotSerialized = serializeRequestPayloadForRetry(originalRequestSnapshot);
        let attempt = 0;
        let lastError: unknown;
        let initialRoutePool: string[] | null = null;
        let antigravityRetrySignal: AntigravityRetrySignal | null = null;
        let poolCooldownWaitBudgetMs = 60 * 1000;
        let forcedRouteHint: string | undefined;
        let contextOverflowRetries = 0;
        const MAX_CONTEXT_OVERFLOW_RETRIES = 3;
        let cumulativeExternalLatencyMs = 0;
        let cumulativeTrafficWaitMs = 0;
        let cumulativeClientInjectWaitMs = 0;

        while (attempt < maxAttempts) {
        attempt += 1;
        // Ensure each attempt starts from the base requestId so pipeline snapshots
        // don't inherit a provider-specific id from a previous attempt.
        input.requestId = providerRequestId;
        if (attempt > 1 && originalRequestSnapshot && typeof originalRequestSnapshot === 'object') {
          const cloned = restoreRequestPayloadFromRetrySnapshot(
            originalRequestSnapshotSerialized,
            originalRequestSnapshot as Record<string, unknown>
          );
          if (cloned && typeof cloned === 'object') {
            input.body = cloned;
          }
        }
        const metadataForAttempt = decorateMetadataForAttempt(initialMetadata, attempt, excludedProviderKeys);
        if (forcedRouteHint) {
          metadataForAttempt.routeHint = forcedRouteHint;
        }
        const metadataRt =
          metadataForAttempt.__rt && typeof metadataForAttempt.__rt === 'object' && !Array.isArray(metadataForAttempt.__rt)
            ? (metadataForAttempt.__rt as Record<string, unknown>)
            : {};
        metadataForAttempt.__rt = {
          ...metadataRt,
          disableVirtualRouterHitLog: true
        };
        // llmswitch Hub 仍有一条 legacy virtual-router-hit 调试日志（无 concurrency 信息）。
        // 为保证控制台只保留一条统一格式（含 [concurrency:x/y]）的命中日志，这里对
        // metadata.logger 做最小化降噪：仅屏蔽 logVirtualRouterHit，不影响其他 logger 能力。
        const loggerRecord =
          metadataForAttempt.logger &&
          typeof metadataForAttempt.logger === 'object' &&
          !Array.isArray(metadataForAttempt.logger)
            ? (metadataForAttempt.logger as Record<string, unknown>)
            : undefined;
        if (loggerRecord && typeof loggerRecord.logVirtualRouterHit === 'function') {
          metadataForAttempt.logger = {
            ...loggerRecord,
            logVirtualRouterHit: undefined
          };
        }
        const clientHeadersForAttempt =
          cloneClientHeaders(metadataForAttempt?.clientHeaders) || inboundClientHeaders;
        if (clientHeadersForAttempt) {
          metadataForAttempt.clientHeaders = clientHeadersForAttempt;
        }
        metadataForAttempt.clientRequestId = clientRequestId;
        injectAntigravityRetrySignal(metadataForAttempt, antigravityRetrySignal);
        const hubStartedAtMs = Date.now();
        this.logStage(`${pipelineLabel}.start`, providerRequestId, {
          endpoint: input.entryEndpoint,
          stream: metadataForAttempt.stream,
          attempt
        });
        let pipelineResult: Awaited<ReturnType<typeof runHubPipeline>>;
        try {
          pipelineResult = await runHubPipeline(hubPipeline, input, metadataForAttempt);
        } catch (pipelineError) {
          if (isPoolExhaustedPipelineError(pipelineError)) {
            const cooldownWaitMs = resolvePoolCooldownWaitMs(pipelineError);
            if (
              cooldownWaitMs &&
              attempt < maxAttempts &&
              poolCooldownWaitBudgetMs >= cooldownWaitMs
            ) {
              this.logStage(`${pipelineLabel}.completed`, providerRequestId, {
                route: undefined,
                target: undefined,
                elapsedMs: Date.now() - hubStartedAtMs,
                attempt,
                recoverablePoolCooldown: true
              });
              this.logStage('provider.route_pool_cooldown_wait', providerRequestId, {
                attempt,
                waitMs: cooldownWaitMs,
                waitBudgetMs: poolCooldownWaitBudgetMs,
                reason: 'provider_pool_cooling_down'
              });
              poolCooldownWaitBudgetMs -= cooldownWaitMs;
              await new Promise((resolve) => setTimeout(resolve, cooldownWaitMs));
              attempt = Math.max(0, attempt - 1);
              continue;
            }
            if (lastError) {
              throw lastError;
            }
          }
          throw pipelineError;
        }
        const pipelineMetadata = pipelineResult.metadata ?? {};
        const mergedMetadata = mergeMetadataPreservingDefined(metadataForAttempt, pipelineMetadata);
        registerRequestLogContext(input.requestId, {
          sessionId: mergedMetadata.sessionId,
          conversationId: mergedMetadata.conversationId
        });
        const mergedClientHeaders =
          cloneClientHeaders(mergedMetadata?.clientHeaders) || clientHeadersForAttempt;
        if (mergedClientHeaders) {
          mergedMetadata.clientHeaders = mergedClientHeaders;
        }
        mergedMetadata.clientRequestId = clientRequestId;
        this.logStage(`${pipelineLabel}.completed`, providerRequestId, {
          route: pipelineResult.routingDecision?.routeName,
          target: pipelineResult.target?.providerKey,
          elapsedMs: Date.now() - hubStartedAtMs,
          attempt
        });
        if (!initialRoutePool && Array.isArray(pipelineResult.routingDecision?.pool)) {
          initialRoutePool = [...pipelineResult.routingDecision!.pool];
        }
        const routePoolForAttempt = Array.isArray(pipelineResult.routingDecision?.pool)
          ? pipelineResult.routingDecision.pool
          : (initialRoutePool ?? []);

        const providerPayload = pipelineResult.providerPayload;
        const target = pipelineResult.target;
        if (!providerPayload || !target?.providerKey) {
          throw Object.assign(new Error('Virtual router did not produce a provider target'), {
            code: 'ERR_NO_PROVIDER_TARGET',
            requestId: input.requestId
          });
        }
        // Ensure response-side conversion always uses the route-selected target metadata.
        // ServerTool followups may carry stale metadata from the previous hop; response compat
        // must follow the current target/provider, not the inherited request profile.
        mergedMetadata.target = target;
        if (typeof target.compatibilityProfile === 'string' && target.compatibilityProfile.trim()) {
          mergedMetadata.compatibilityProfile = target.compatibilityProfile.trim();
        } else if (Object.prototype.hasOwnProperty.call(mergedMetadata, 'compatibilityProfile')) {
          delete mergedMetadata.compatibilityProfile;
        }

        let runtimeKey: string;
        let handle: ProviderHandle;
        let providerContext: ReturnType<typeof resolveProviderRequestContext>;
        try {
          this.logStage('provider.runtime_resolve.start', providerRequestId, {
            providerKey: target.providerKey,
            route: pipelineResult.routingDecision?.routeName,
            attempt
          });
          const resolved = await resolveProviderRuntimeOrThrow({
            requestId: input.requestId,
            target: {
              providerKey: target.providerKey,
              outboundProfile: String((target as any).outboundProfile || ''),
              providerType: String((target as any).providerType || '')
            },
            routeName: pipelineResult.routingDecision?.routeName,
            runtimeKeyHint: target.runtimeKey,
            runtimeManager: this.deps.runtimeManager,
            dependencies: this.deps.getModuleDependencies()
          });
          runtimeKey = resolved.runtimeKey;
          handle = resolved.handle;
          this.logStage('provider.runtime_resolve.completed', providerRequestId, {
            providerKey: target.providerKey,
            runtimeKey,
            providerType: handle.providerType,
            providerFamily: handle.providerFamily,
            attempt
          });

          this.logStage('provider.context_resolve.start', providerRequestId, {
            providerKey: target.providerKey,
            runtimeKey,
            attempt
          });
          providerContext = resolveProviderRequestContext({
            providerRequestId,
            entryEndpoint: input.entryEndpoint,
            target: {
              providerKey: target.providerKey,
              outboundProfile: target.outboundProfile as ProviderProtocol
            },
            handle,
            runtimeKey,
            providerPayload,
            mergedMetadata
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error ?? 'Unknown error');
          const retryError = extractRetryErrorSnapshot(error);
          this.logStage('provider.runtime_resolve.error', providerRequestId, {
            providerKey: target.providerKey,
            message: errorMessage,
            ...(typeof retryError.statusCode === 'number' ? { statusCode: retryError.statusCode } : {}),
            ...(retryError.errorCode ? { errorCode: retryError.errorCode } : {}),
            ...(retryError.upstreamCode ? { upstreamCode: retryError.upstreamCode } : {}),
            attempt
          });
          lastError = error;
          const blockingRecoverable = isBlockingRecoverableRetryError({
            statusCode: retryError.statusCode,
            errorCode: retryError.errorCode,
            upstreamCode: retryError.upstreamCode,
            reason: retryError.reason
          });
          const shouldRetry =
            blockingRecoverable
              ? shouldRetryProviderError(error)
              : (attempt < maxAttempts && shouldRetryProviderError(error));
          if (!shouldRetry) {
            recordAttempt({ error: true });
            throw error;
          }
          recordAttempt({ error: true });
          let retryBackoffMs = 0;
          let recoverableBackoffMs = 0;
          if (blockingRecoverable) {
            const recoverableKey = buildRecoverableErrorBackoffKey({
              statusCode: retryError.statusCode,
              errorCode: retryError.errorCode,
              upstreamCode: retryError.upstreamCode,
              reason: retryError.reason
            });
            recoverableBackoffMs = consumeRecoverableErrorBackoffMs(recoverableKey);
            await waitRecoverableBackoffWithGlobalGate(recoverableKey, recoverableBackoffMs);
            retryBackoffMs = recoverableBackoffMs;
          } else {
            retryBackoffMs = await waitBeforeRetry(error, { attempt });
          }
          const singleProviderPool =
            Boolean(initialRoutePool && initialRoutePool.length === 1 && initialRoutePool[0] === target.providerKey);
          const holdOnLastAvailable429 =
            retryError.statusCode === 429 &&
            routePoolForAttempt.length > 0 &&
            !routePoolHasAlternativeProvider({
              routePool: routePoolForAttempt,
              excludedProviderKeys,
              currentProviderKey: target.providerKey
            });
          const holdOnCurrentProvider = holdOnLastAvailable429;
          if (!singleProviderPool && !holdOnCurrentProvider && target.providerKey) {
            excludedProviderKeys.add(target.providerKey);
          }
          const switchAction: 'exclude_and_reroute' | 'retry_same_provider' =
            (singleProviderPool || holdOnCurrentProvider) ? 'retry_same_provider' : 'exclude_and_reroute';
          this.logProviderRetrySwitch({
            requestId: providerRequestId,
            attempt,
            maxAttempts,
            providerKey: target.providerKey,
            nextAttempt: attempt + 1,
            reason: retryError.reason,
            backoffMs: retryBackoffMs,
            statusCode: retryError.statusCode,
            errorCode: retryError.errorCode,
            upstreamCode: retryError.upstreamCode,
            switchAction
          });
          this.logStage('provider.retry', input.requestId, {
            providerKey: target.providerKey,
            attempt,
            nextAttempt: attempt + 1,
            excluded: Array.from(excludedProviderKeys),
            reason: retryError.reason,
            routeHint: forcedRouteHint,
            switchAction,
            ...(typeof retryError.statusCode === 'number' ? { statusCode: retryError.statusCode } : {}),
            ...(retryError.errorCode ? { errorCode: retryError.errorCode } : {}),
            ...(retryError.upstreamCode ? { upstreamCode: retryError.upstreamCode } : {}),
            retryBackoffMs,
            recoverableBackoffMs,
            holdOnLastAvailable429,
            blockingRecoverable
          });
          if (blockingRecoverable && attempt >= maxAttempts) {
            attempt = Math.max(0, attempt - 1);
          }
          continue;
        }
        const previousRequestId = input.requestId;
        if (providerContext.requestId !== input.requestId) {
          input.requestId = providerContext.requestId;
        }
        this.logStage('provider.context_resolve.completed', input.requestId, {
          providerKey: target.providerKey,
          runtimeKey,
          providerProtocol: providerContext.providerProtocol,
          model: providerContext.providerModel,
          requestIdChanged: previousRequestId !== input.requestId,
          previousRequestId,
          requestId: input.requestId,
          attempt
        });
        registerRequestLogContext(providerContext.requestId, {
          sessionId: mergedMetadata.sessionId,
          conversationId: mergedMetadata.conversationId
        });
        const { providerProtocol, providerModel, providerLabel } = providerContext;
        if (clientHeadersForAttempt) {
          ensureClientHeadersOnPayload(providerPayload, clientHeadersForAttempt);
        }
        this.deps.stats.bindProvider(statsRequestId, {
          providerKey: target.providerKey,
          providerType: handle.providerType,
          model: providerModel
        });

        this.logStage('provider.prepare', input.requestId, {
          providerKey: target.providerKey,
          runtimeKey,
          protocol: providerProtocol,
          providerType: handle.providerType,
          providerFamily: handle.providerFamily,
          model: providerModel,
          providerLabel,
          attempt
        });

        this.logStage('provider.metadata_attach.start', input.requestId, {
          providerKey: target.providerKey,
          runtimeKey,
          attempt
        });
        attachProviderRuntimeMetadata(providerPayload, {
          requestId: input.requestId,
          providerId: handle.providerId,
          providerKey: target.providerKey,
          providerType: handle.providerType,
          providerFamily: handle.providerFamily,
          providerProtocol,
          pipelineId: target.providerKey,
          routeName: pipelineResult.routingDecision?.routeName,
          runtimeKey,
          target,
          metadata: mergedMetadata,
          compatibilityProfile: target.compatibilityProfile
        });
        this.logStage('provider.metadata_attach.completed', input.requestId, {
          providerKey: target.providerKey,
          runtimeKey,
          attempt
        });

        let trafficPermit: ProviderTrafficPermit | null = null;
        let providerSendStartedAtMs = 0;
        let providerSendElapsedMs = 0;
        try {
          this.logStage('provider.traffic.acquire.start', input.requestId, {
            providerKey: target.providerKey,
            runtimeKey,
            attempt
          });
          const trafficAcquired = await this.trafficGovernor.acquire({
            runtimeKey,
            providerKey: target.providerKey,
            requestId: input.requestId,
            runtime: resolveTrafficRuntimeProfile(runtimeKey, handle, target.providerKey),
            // Hard rule (2026-04): local traffic saturation must block-wait/backoff instead of
            // switch storm. Do not use soft timeout here.
            softWaitTimeoutMs: undefined
          });
          trafficPermit = trafficAcquired.permit;
          if (trafficAcquired.waitedMs > 0) {
            cumulativeTrafficWaitMs += trafficAcquired.waitedMs;
            this.logStage('provider.traffic.acquire.wait', input.requestId, {
              providerKey: target.providerKey,
              runtimeKey,
              waitedMs: trafficAcquired.waitedMs,
              attempt
            });
          }
          this.logStage('provider.traffic.acquire.completed', input.requestId, {
            providerKey: target.providerKey,
            runtimeKey,
            maxInFlight: trafficAcquired.policy.concurrency.maxInFlight,
            requestsPerMinute: trafficAcquired.policy.rpm.requestsPerMinute,
            activeInFlight: trafficAcquired.activeInFlight,
            rpmInWindow: trafficAcquired.rpmInWindow,
            attempt
          });
          const routingDecisionRecord =
            pipelineResult.routingDecision && typeof pipelineResult.routingDecision === 'object'
              ? (pipelineResult.routingDecision as Record<string, unknown>)
              : undefined;
          emitVirtualRouterConcurrencyLog({
            sessionId: readString(mergedMetadata.sessionId) ?? readString(mergedMetadata.conversationId),
            projectPath:
              readString(mergedMetadata.clientWorkdir)
              ?? readString(mergedMetadata.client_workdir)
              ?? readString(mergedMetadata.workdir)
              ?? readString(mergedMetadata.cwd),
            routeName: pipelineResult.routingDecision?.routeName,
            poolId: readString(routingDecisionRecord?.poolId),
            providerKey: target.providerKey,
            model: providerModel,
            reason: readString(routingDecisionRecord?.reasoning),
            activeInFlight: trafficAcquired.activeInFlight,
            maxInFlight: trafficAcquired.policy.concurrency.maxInFlight
          });

          providerSendStartedAtMs = Date.now();
          this.logStage('provider.send.start', input.requestId, {
            providerKey: target.providerKey,
            runtimeKey,
            protocol: providerProtocol,
            providerType: handle.providerType,
            providerFamily: handle.providerFamily,
            model: providerModel,
            providerLabel,
            attempt
          });

          const providerResponse = await handle.instance.processIncoming(providerPayload);
          const responseStatus = extractResponseStatus(providerResponse);
          providerSendElapsedMs = Date.now() - providerSendStartedAtMs;
          cumulativeExternalLatencyMs += providerSendElapsedMs;
          this.logStage('provider.send.completed', input.requestId, {
            providerKey: target.providerKey,
            status: responseStatus,
            elapsedMs: providerSendElapsedMs,
            providerType: handle.providerType,
            providerFamily: handle.providerFamily,
            model: providerModel,
            providerLabel,
            attempt
          });
          const wantsStreamBase = Boolean(input.metadata?.inboundStream ?? input.metadata?.stream);
          this.logStage('provider.response_normalize.start', input.requestId, {
            providerKey: target.providerKey,
            attempt
          });
          const normalized = normalizeProviderResponse(providerResponse);
          this.logStage('provider.response_normalize.completed', input.requestId, {
            providerKey: target.providerKey,
            status: normalized.status,
            attempt
          });
          this.logStage('provider.usage_extract.start', input.requestId, {
            providerKey: target.providerKey,
            source: 'provider_response',
            attempt
          });
          const usageFromProvider = extractUsageFromResult(normalized, mergedMetadata);
          this.logStage('provider.usage_extract.completed', input.requestId, {
            providerKey: target.providerKey,
            source: 'provider_response',
            hasUsage: Boolean(usageFromProvider),
            attempt
          });
          this.logStage('provider.request_semantics.start', input.requestId, {
            providerKey: target.providerKey,
            attempt
          });
          const requestSemantics = resolveRequestSemantics(
            pipelineResult.processedRequest as Record<string, unknown> | undefined,
            pipelineResult.standardizedRequest as Record<string, unknown> | undefined
          );
          this.logStage('provider.request_semantics.completed', input.requestId, {
            providerKey: target.providerKey,
            hasSemantics: Boolean(requestSemantics && Object.keys(requestSemantics).length),
            attempt
          });
          const serverToolsEnabled = isServerToolEnabled();
          this.logStage('provider.response_convert.start', input.requestId, {
            providerKey: target.providerKey,
            protocol: providerProtocol,
            processMode: pipelineResult.processMode,
            wantsStream: wantsStreamBase,
            serverToolsEnabled,
            attempt
          });
          const hubResponseStartedAtMs = Date.now();
          this.logStage('hub.response.start', input.requestId, {
            providerKey: target.providerKey,
            protocol: providerProtocol,
            processMode: pipelineResult.processMode,
            attempt
          });
          const converted = await this.convertProviderResponseIfNeeded({
            entryEndpoint: input.entryEndpoint,
            providerProtocol,
            providerType: handle.providerType,
            requestId: input.requestId,
            serverToolsEnabled,
            wantsStream: wantsStreamBase,
            originalRequest: originalRequestSnapshot,
            requestSemantics,
            processMode: pipelineResult.processMode,
            response: normalized,
            pipelineMetadata: mergedMetadata
          });
          const clientInjectWaitMsRaw = converted.timingBreakdown?.hubResponseExcludedMs;
          const clientInjectWaitMs =
            typeof clientInjectWaitMsRaw === 'number' && Number.isFinite(clientInjectWaitMsRaw)
              ? Math.max(0, Math.floor(clientInjectWaitMsRaw))
              : 0;
          if (clientInjectWaitMs > 0) {
            cumulativeClientInjectWaitMs += clientInjectWaitMs;
          }
          const hubResponseElapsedMsRaw = Date.now() - hubResponseStartedAtMs;
          const hubResponseElapsedMs = Math.max(0, hubResponseElapsedMsRaw - clientInjectWaitMs);
          const convertedBodyRecord =
            converted.body && typeof converted.body === 'object'
              ? (converted.body as Record<string, unknown>)
              : undefined;
          const normalizedBodyRecord =
            normalized.body && typeof normalized.body === 'object'
              ? (normalized.body as Record<string, unknown>)
              : undefined;
          if (convertedBodyRecord) {
            backfillResponsesOutputTextIfMissing(convertedBodyRecord);
          }
          const finishReason = (() => {
            if (
              convertedBodyRecord
              && typeof convertedBodyRecord[STREAM_LOG_FINISH_REASON_KEY] === 'string'
            ) {
              return String(convertedBodyRecord[STREAM_LOG_FINISH_REASON_KEY]);
            }
            const fromConverted = deriveFinishReason(convertedBodyRecord);
            if (fromConverted) {
              return fromConverted;
            }
            return deriveFinishReason(normalizedBodyRecord);
          })();
          this.logStage('provider.response_convert.completed', input.requestId, {
            providerKey: target.providerKey,
            status: converted.status,
            hasBody: converted.body !== undefined && converted.body !== null,
            attempt
          });
          if (clientInjectWaitMs > 0) {
            this.logStage('client.inject_wait.start', input.requestId, {
              providerKey: target.providerKey,
              attempt
            });
            this.logStage('client.inject_wait.completed', input.requestId, {
              providerKey: target.providerKey,
              elapsedMs: clientInjectWaitMs,
              attempt
            });
          }
          this.logStage('hub.response.completed', input.requestId, {
            providerKey: target.providerKey,
            status: converted.status,
            elapsedMs: hubResponseElapsedMs,
            ...(clientInjectWaitMs > 0 ? { excludedClientInjectWaitMs: clientInjectWaitMs } : {}),
            hasBody: converted.body !== undefined && converted.body !== null,
            ...(finishReason ? { finishReason } : {}),
            attempt
          });
          // Treat upstream auth/rate-limit failures as provider failure across protocols to avoid
          // leaking provider-local errors to clients while route pool still has candidates.
          // Keep existing Gemini compatibility behavior for 400/4xx thoughtSignature-like failures.
          const convertedStatus = typeof converted.status === 'number' ? converted.status : undefined;
          this.logStage('provider.response_status_check.start', input.requestId, {
            providerKey: target.providerKey,
            convertedStatus,
            attempt
          });
          const isGlobalRetryableStatus =
            typeof convertedStatus === 'number' &&
            (convertedStatus === 401 ||
              convertedStatus === 429 ||
              convertedStatus === 408 ||
              convertedStatus === 425 ||
              convertedStatus >= 500);
          const isGeminiCompatFailure =
            typeof convertedStatus === 'number' &&
            convertedStatus >= 400 &&
            (isAntigravityProviderKey(target.providerKey) ||
              (typeof target.providerKey === 'string' && target.providerKey.startsWith('gemini-cli.'))) &&
              providerProtocol === 'gemini-chat';

          if (isGlobalRetryableStatus || isGeminiCompatFailure) {
            const bodyForError = converted.body && typeof converted.body === 'object' ? (converted.body as Record<string, unknown>) : undefined;
            const errMsg =
              bodyForError && bodyForError.error && typeof bodyForError.error === 'object'
                ? String((bodyForError.error as any).message || bodyForError.error || '')
                : '';
            const statusCode = typeof convertedStatus === 'number' ? convertedStatus : 500;
            const errorToThrow: any = new Error(errMsg && errMsg.trim().length ? errMsg : `HTTP ${statusCode}`);
            errorToThrow.statusCode = statusCode;
            errorToThrow.status = statusCode;
            errorToThrow.response = { data: bodyForError };
            try {
              const { emitProviderError } = await import('../../../providers/core/utils/provider-error-reporter.js');
              emitProviderError({
                error: errorToThrow,
                stage: 'provider.http',
                runtime: {
                  requestId: input.requestId,
                  providerKey: target.providerKey,
                  providerId: handle.providerId,
                  providerType: handle.providerType,
                  providerFamily: handle.providerFamily,
                  providerProtocol,
                  routeName: pipelineResult.routingDecision?.routeName,
                  pipelineId: target.providerKey,
                  target,
                  runtimeKey
                },
                dependencies: this.deps.getModuleDependencies(),
                statusCode,
                recoverable:
                  statusCode === 401 ||
                  statusCode === 429 ||
                  statusCode === 408 ||
                  statusCode === 425 ||
                  statusCode >= 500,
                affectsHealth: true,
                details: {
                  source: 'converted_response_status',
                  convertedStatus: statusCode,
                  wrappedErrorResponse: true
                }
              });
            } catch (reportError) {
              // best-effort; never block retry/failover path
              this.logStage('provider.error_reporter.failed', input.requestId, {
                providerKey: target.providerKey,
                stage: 'provider.http',
                convertedStatus: statusCode,
                message: reportError instanceof Error ? reportError.message : String(reportError ?? 'Unknown reporter error'),
                attempt
              });
            }
            throw errorToThrow;
          }
          this.logStage('provider.response_status_check.completed', input.requestId, {
            providerKey: target.providerKey,
            convertedStatus,
            attempt
          });
          const emptyAssistantSignal = detectRetryableEmptyAssistantResponse(converted.body);
          if (emptyAssistantSignal) {
            const bodyForError = converted.body as Record<string, unknown>;
            const errorToThrow: any = new Error(
              `Upstream returned empty assistant payload: ${emptyAssistantSignal.reason}`
            );
            errorToThrow.statusCode = 502;
            errorToThrow.status = 502;
            errorToThrow.code = 'EMPTY_ASSISTANT_RESPONSE';
            errorToThrow.response = { data: bodyForError };
            this.logStage('provider.empty_assistant_retry', input.requestId, {
              providerKey: target.providerKey,
              marker: emptyAssistantSignal.marker,
              reason: emptyAssistantSignal.reason,
              attempt
            });
            throw errorToThrow;
          }
          this.logStage('provider.usage_extract.start', input.requestId, {
            providerKey: target.providerKey,
            source: 'converted_response',
            attempt
          });
          const usage = extractUsageFromResult(converted, mergedMetadata) ?? usageFromProvider;
          this.logStage('provider.usage_extract.completed', input.requestId, {
            providerKey: target.providerKey,
            source: 'converted_response',
            hasUsage: Boolean(usage),
            attempt
          });
          aggregatedUsage = mergeUsageMetrics(aggregatedUsage, usage);
          this.logStage('provider.tool_usage_record.start', input.requestId, {
            providerKey: target.providerKey,
            attempt
          });
          if (converted.body && typeof converted.body === 'object') {
            const body = converted.body as Record<string, unknown>;
            if (!('__sse_responses' in body)) {
              this.deps.stats.recordToolUsage(
                { providerKey: target.providerKey, model: providerModel },
                body
              );
            }
          }
          this.logStage('provider.tool_usage_record.completed', input.requestId, {
            providerKey: target.providerKey,
            attempt
          });

          recordAttempt({ usage: aggregatedUsage, error: false });
          const metadataHubStageTop = readHubStageTop(mergedMetadata);
          const hubDecodeBreakdown = readHubDecodeBreakdown(metadataHubStageTop);
          return {
            ...converted,
            usageLogInfo: {
              providerKey: target.providerKey,
              model: providerModel,
              routeName: pipelineResult.routingDecision?.routeName,
              poolId: readString(routingDecisionRecord?.poolId),
              finishReason,
              usage: aggregatedUsage as Record<string, unknown> | undefined,
              externalLatencyMs: cumulativeExternalLatencyMs > 0 ? cumulativeExternalLatencyMs : undefined,
              trafficWaitMs: cumulativeTrafficWaitMs > 0 ? cumulativeTrafficWaitMs : undefined,
              clientInjectWaitMs: cumulativeClientInjectWaitMs > 0 ? cumulativeClientInjectWaitMs : undefined,
              sseDecodeMs: hubDecodeBreakdown.sseDecodeMs > 0 ? hubDecodeBreakdown.sseDecodeMs : undefined,
              codecDecodeMs: hubDecodeBreakdown.codecDecodeMs > 0 ? hubDecodeBreakdown.codecDecodeMs : undefined,
              providerAttemptCount: attempt,
              retryCount: Math.max(0, attempt - 1),
              hubStageTop: metadataHubStageTop,
              requestStartedAtMs: requestStartedAt,
              timingRequestIds: Array.from(
                new Set([providerRequestId, input.requestId].filter((value): value is string => Boolean(value)))
              ),
              sessionId: mergedMetadata.sessionId,
              conversationId: mergedMetadata.conversationId,
              projectPath:
                readString(mergedMetadata.clientWorkdir)
                ?? readString(mergedMetadata.client_workdir)
                ?? readString(mergedMetadata.workdir)
                ?? readString(mergedMetadata.cwd)
            }
          };
        } catch (error) {
          if (providerSendStartedAtMs > 0 && providerSendElapsedMs <= 0) {
            const failedSendElapsedMs = Math.max(0, Date.now() - providerSendStartedAtMs);
            if (failedSendElapsedMs > 0) {
              providerSendElapsedMs = failedSendElapsedMs;
              cumulativeExternalLatencyMs += failedSendElapsedMs;
              this.logStage('provider.send.failed_elapsed', input.requestId, {
                providerKey: target.providerKey,
                elapsedMs: failedSendElapsedMs,
                attempt
              });
            }
          }
          const errorMessage = error instanceof Error ? error.message : String(error ?? 'Unknown error');
          const retryError = extractRetryErrorSnapshot(error);
          this.logStage('provider.send.error', input.requestId, {
            providerKey: target.providerKey,
            message: errorMessage,
            providerType: handle.providerType,
            providerFamily: handle.providerFamily,
            model: providerModel,
            providerLabel,
            ...(typeof retryError.statusCode === 'number' ? { statusCode: retryError.statusCode } : {}),
            ...(retryError.errorCode ? { errorCode: retryError.errorCode } : {}),
            ...(retryError.upstreamCode ? { upstreamCode: retryError.upstreamCode } : {}),
            attempt
          });
          lastError = error;
          if (isAntigravityProviderKey(target.providerKey)) {
            const signature = extractRetryErrorSignature(error);
            const consecutive: number =
              antigravityRetrySignal && antigravityRetrySignal.signature === signature
                ? antigravityRetrySignal.consecutive + 1
                : 1;
            antigravityRetrySignal = { signature, consecutive };
          } else {
            antigravityRetrySignal = null;
          }
          const status = extractStatusCodeFromError(error);
          if (isSseDecodeRateLimitError(error, status)) {
            try {
              const { emitProviderError } = await import('../../../providers/core/utils/provider-error-reporter.js');
              emitProviderError({
                error,
                stage: 'provider.sse_decode',
                runtime: {
                  requestId: input.requestId,
                  providerKey: target.providerKey,
                  providerId: handle.providerId,
                  providerType: handle.providerType,
                  providerFamily: handle.providerFamily,
                  providerProtocol,
                  routeName: pipelineResult.routingDecision?.routeName,
                  pipelineId: target.providerKey,
                  target,
                  runtimeKey
                },
                dependencies: this.deps.getModuleDependencies(),
                statusCode: 429,
                recoverable: true,
                affectsHealth: true,
                details: {
                  source: 'sse_decode_rate_limit',
                  errorCode: typeof (error as any)?.code === 'string' ? String((error as any).code) : undefined,
                  upstreamCode: typeof (error as any)?.upstreamCode === 'string' ? String((error as any).upstreamCode) : undefined,
                  message: errorMessage
                }
              });
            } catch (reportError) {
              // best-effort; never block retry/failover path
              this.logStage('provider.error_reporter.failed', input.requestId, {
                providerKey: target.providerKey,
                stage: 'provider.sse_decode_rate_limit',
                statusCode: 429,
                message: reportError instanceof Error ? reportError.message : String(reportError ?? 'Unknown reporter error'),
                attempt
              });
            }
          } else if (isSseDecodeRetryableNetworkError(error, status)) {
            try {
              const { emitProviderError } = await import('../../../providers/core/utils/provider-error-reporter.js');
              emitProviderError({
                error,
                stage: 'provider.sse_decode',
                runtime: {
                  requestId: input.requestId,
                  providerKey: target.providerKey,
                  providerId: handle.providerId,
                  providerType: handle.providerType,
                  providerFamily: handle.providerFamily,
                  providerProtocol,
                  routeName: pipelineResult.routingDecision?.routeName,
                  pipelineId: target.providerKey,
                  target,
                  runtimeKey
                },
                dependencies: this.deps.getModuleDependencies(),
                statusCode: 502,
                recoverable: true,
                affectsHealth: true,
                details: {
                  source: 'sse_decode_network_error',
                  errorCode: typeof (error as any)?.code === 'string' ? String((error as any).code) : undefined,
                  upstreamCode: typeof (error as any)?.upstreamCode === 'string' ? String((error as any).upstreamCode) : undefined,
                  message: errorMessage
                }
              });
            } catch (reportError) {
              // best-effort; never block retry/failover path
              this.logStage('provider.error_reporter.failed', input.requestId, {
                providerKey: target.providerKey,
                stage: 'provider.sse_decode_network_error',
                statusCode: 502,
                message: reportError instanceof Error ? reportError.message : String(reportError ?? 'Unknown reporter error'),
                attempt
              });
            }
          }
          const isVerify = status === 403 && isGoogleAccountVerificationRequiredError(error);
          const isReauth = status === 403 && isAntigravityReauthRequired403(error);
          const promptTooLong = isPromptTooLongError(error);
          if (promptTooLong) {
            contextOverflowRetries += 1;
            if (forcedRouteHint !== 'longcontext') {
              forcedRouteHint = 'longcontext';
            }
          }
          const shouldRetry =
            (() => {
              const blockingRecoverable = isBlockingRecoverableRetryError({
                statusCode: retryError.statusCode,
                errorCode: retryError.errorCode,
                upstreamCode: retryError.upstreamCode,
                reason: retryError.reason
              });
              if (blockingRecoverable) {
                return shouldRetryProviderError(error);
              }
              return (
                attempt < maxAttempts &&
                (promptTooLong
                  ? contextOverflowRetries < MAX_CONTEXT_OVERFLOW_RETRIES
                  : (shouldRetryProviderError(error) ||
                      (isAntigravityProviderKey(target.providerKey) && (isVerify || isReauth))))
              );
            })();
          if (!shouldRetry) {
            recordAttempt({ error: true });
            throw error;
          }
          // Record this failed provider attempt even if the overall request succeeds later via failover.
          recordAttempt({ error: true });
          const blockingRecoverable = isBlockingRecoverableRetryError({
            statusCode: retryError.statusCode,
            errorCode: retryError.errorCode,
            upstreamCode: retryError.upstreamCode,
            reason: retryError.reason
          });
          let retryBackoffMs = 0;
          let recoverableBackoffMs = 0;
          if (blockingRecoverable) {
            const recoverableKey = buildRecoverableErrorBackoffKey({
              statusCode: retryError.statusCode,
              errorCode: retryError.errorCode,
              upstreamCode: retryError.upstreamCode,
              reason: retryError.reason
            });
            recoverableBackoffMs = consumeRecoverableErrorBackoffMs(recoverableKey);
            await waitRecoverableBackoffWithGlobalGate(recoverableKey, recoverableBackoffMs);
            retryBackoffMs = recoverableBackoffMs;
          } else {
            retryBackoffMs = await waitBeforeRetry(error, { attempt });
          }
          const singleProviderPool =
            Boolean(initialRoutePool && initialRoutePool.length === 1 && initialRoutePool[0] === target.providerKey);
          const isProviderTrafficSaturated =
            retryError.errorCode === 'PROVIDER_TRAFFIC_SATURATED'
            || (typeof (error as { code?: unknown })?.code === 'string'
              && (error as { code?: string }).code === 'PROVIDER_TRAFFIC_SATURATED');
          const holdOnLastAvailable429 =
            status === 429 &&
            routePoolForAttempt.length > 0 &&
            !routePoolHasAlternativeProvider({
              routePool: routePoolForAttempt,
              excludedProviderKeys,
              currentProviderKey: target.providerKey
            });
          const holdOnCurrentProvider = holdOnLastAvailable429;
          if (promptTooLong && target.providerKey) {
            excludedProviderKeys.add(target.providerKey);
          }
          if (!promptTooLong && !singleProviderPool && !holdOnCurrentProvider && target.providerKey) {
            const is429 = status === 429;
            if (isAntigravityProviderKey(target.providerKey) && (isVerify || is429)) {
              // For Antigravity 403 verify / 429 states:
              // - exclude the current providerKey so we don't immediately retry the same account
              // - avoid ALL other Antigravity aliases on retry (prefer non-Antigravity fallbacks)
              excludedProviderKeys.add(target.providerKey);
              if (antigravityRetrySignal) {
                antigravityRetrySignal.avoidAllOnRetry = true;
              } else {
                antigravityRetrySignal = { signature: extractRetryErrorSignature(error), consecutive: 1, avoidAllOnRetry: true };
              }
            } else if (isAntigravityProviderKey(target.providerKey) && isReauth) {
              // Antigravity OAuth reauth-required 403:
              // - exclude the current providerKey so router can pick another alias
              // - DO NOT avoid all Antigravity on retry; switching aliases is the intended recovery path.
              excludedProviderKeys.add(target.providerKey);
            } else if (!isAntigravityProviderKey(target.providerKey) || shouldRotateAntigravityAliasOnRetry(error)) {
              excludedProviderKeys.add(target.providerKey);
            }
          }
          if (!promptTooLong && !singleProviderPool && !holdOnCurrentProvider && isProviderTrafficSaturated) {
            const runtimeScopeExcluded = excludeProvidersSharingRuntimeFromRoutePool({
              routePool: routePoolForAttempt,
              runtimeKey,
              runtimeManager: this.deps.runtimeManager,
              excludedProviderKeys
            });
            if (runtimeScopeExcluded.length > 0) {
              this.logStage('provider.retry.runtime_scope_exclude', input.requestId, {
                providerKey: target.providerKey,
                runtimeKey,
                excludedRuntimeScope: runtimeScopeExcluded,
                attempt
              });
            }
          }
          const switchAction: 'exclude_and_reroute' | 'retry_same_provider' =
            (singleProviderPool || holdOnCurrentProvider) ? 'retry_same_provider' : 'exclude_and_reroute';
          this.logProviderRetrySwitch({
            requestId: input.requestId,
            attempt,
            maxAttempts,
            providerKey: target.providerKey,
            nextAttempt: attempt + 1,
            reason: retryError.reason,
            backoffMs: retryBackoffMs,
            statusCode: retryError.statusCode,
            errorCode: retryError.errorCode,
            upstreamCode: retryError.upstreamCode,
            switchAction
          });
          this.logStage('provider.retry', input.requestId, {
            providerKey: target.providerKey,
            attempt,
            nextAttempt: attempt + 1,
            excluded: Array.from(excludedProviderKeys),
            reason: retryError.reason,
            routeHint: forcedRouteHint,
            switchAction,
            ...(typeof retryError.statusCode === 'number' ? { statusCode: retryError.statusCode } : {}),
            ...(retryError.errorCode ? { errorCode: retryError.errorCode } : {}),
            ...(retryError.upstreamCode ? { upstreamCode: retryError.upstreamCode } : {}),
            retryBackoffMs,
            recoverableBackoffMs,
            holdOnLastAvailable429,
            blockingRecoverable,
            ...(promptTooLong ? { contextOverflowRetries, maxContextOverflowRetries: MAX_CONTEXT_OVERFLOW_RETRIES } : {})
          });
          if (blockingRecoverable && attempt >= maxAttempts) {
            attempt = Math.max(0, attempt - 1);
          }
          continue;
        } finally {
          if (trafficPermit) {
            const releaseStartedAtMs = Date.now();
            this.logStage('provider.traffic.release.start', input.requestId, {
              providerKey: target.providerKey,
              runtimeKey,
              leaseId: trafficPermit.leaseId,
              attempt
            });
            try {
              const released = await this.trafficGovernor.release(trafficPermit);
              this.logStage('provider.traffic.release.completed', input.requestId, {
                providerKey: target.providerKey,
                runtimeKey,
                leaseId: trafficPermit.leaseId,
                released: released.released,
                activeInFlight: released.activeInFlight,
                elapsedMs: Date.now() - releaseStartedAtMs,
                attempt
              });
            } catch (releaseError) {
              this.logStage('provider.traffic.release.error', input.requestId, {
                providerKey: target.providerKey,
                runtimeKey,
                leaseId: trafficPermit.leaseId,
                message:
                  releaseError instanceof Error
                    ? releaseError.message
                    : String(releaseError ?? 'Unknown release error'),
                elapsedMs: Date.now() - releaseStartedAtMs,
                attempt
              });
            } finally {
              trafficPermit = null;
            }
          }
        }
        }

        throw lastError ?? new Error('Provider execution failed without response');
      } finally {
        await this.deps.onRequestEnd?.({ requestId: executorRequestId });
      }
    } catch (error: unknown) {
      // If we failed before selecting a provider (no bindProvider/recordAttempt),
      // at least record one error sample for this request.
      if (!recordedAnyAttempt) {
        recordAttempt({ error: true });
      }
      throw error;
    }
  }
  private logStage(stage: string, requestId: string, details?: Record<string, unknown>): void {
    this.deps.logStage(stage, requestId, details);
  }

  private async convertProviderResponseIfNeeded(options: ConvertProviderResponseOptions): Promise<PipelineExecutionResult> {
    return convertProviderResponseWithBridge(options, { runtimeManager: this.deps.runtimeManager, executeNested: (nestedInput) => this.execute(nestedInput) });
  }

}

export const __requestExecutorTestables = {
  readString,
  extractRetryErrorSnapshot,
  truncateReason,
  detectRetryableEmptyAssistantResponse
};

export function createRequestExecutor(deps: RequestExecutorDeps): RequestExecutor {
  return new HubRequestExecutor(deps);
}
