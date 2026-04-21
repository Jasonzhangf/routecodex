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
  loadRoutingInstructionStateSync,
  rebindResponsesConversationRequestId
} from '../../../modules/llmswitch/bridge.js';
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
import { isClientDisconnectAbortError } from './executor-provider.js';
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
import { getClientConnectionAbortSignal } from '../../utils/client-connection-state.js';
import { deriveFinishReason, STREAM_LOG_FINISH_REASON_KEY } from '../../utils/finish-reason.js';
import { allowSnapshotLocalDiskWrite } from '../../../utils/snapshot-local-disk-gate.js';
import {
  REASONING_STOP_FINALIZED_FLAG_KEY,
  REASONING_STOP_FINALIZED_MARKER
} from './executor/servertool-response-normalizer.js';
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
const requestDegradedLogState = new Set<string>();
const RECOVERABLE_BACKOFF_TTL_MS = 5 * 60_000;
const recoverableErrorBackoffState = new Map<string, { consecutive: number; updatedAtMs: number }>();
const recoverableRetryGateState = new Map<string, Promise<void>>();
const recoverableRetryWaiterState = new Map<string, { activeWaiters: number; updatedAtMs: number }>();
const logicalChainRetryState = new Map<string, {
  recoverableRetries: number;
  updatedAtMs: number;
  activeExecutions: number;
}>();
const PROVIDER_SWITCH_LOG_THROTTLE_MS = 5_000;
const providerSwitchLogState = new Map<string, { lastAtMs: number; suppressed: number }>();
const RETRY_SNAPSHOT_PARSE_MAX_CHARS = 256 * 1024;
const RETRY_SNAPSHOT_RESTORE_MAX_CHARS = 2 * 1024 * 1024;
const RETRY_SNAPSHOT_SERIALIZE_MAX_CHARS = 256 * 1024;
const RETRY_PAYLOAD_ESTIMATE_MAX_BYTES = RETRY_SNAPSHOT_SERIALIZE_MAX_CHARS * 2;
const RETRY_PAYLOAD_ESTIMATE_NODE_BUDGET = 4000;
const MAX_CONTEXT_OVERFLOW_RETRIES = 3;
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

type QwenChatSseProbe = {
  firstUpstreamChunkMs?: number;
  firstDataFrameMs?: number;
  firstEmitMs?: number;
  firstToolCallMs?: number;
  upstreamDoneMs?: number;
  upstreamChunkCount?: number;
  dataFrameCount?: number;
  ignoredFrameCount?: number;
  emittedChunkCount?: number;
  terminalErrorCode?: string;
};

type QwenChatNonstreamDelivery = 'json' | 'sse_fallback';

type RetryPayloadSeed =
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

function logRequestExecutorDegraded(stage: string, requestId: string, details?: Record<string, unknown>): void {
  const key = `${requestId}:${stage}`;
  if (requestDegradedLogState.has(key)) {
    return;
  }
  requestDegradedLogState.add(key);
  try {
    const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[request-executor][degraded] req=${requestId} stage=${stage}${detailSuffix}`);
  } catch {
    // Never throw from degraded logging.
  }
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

type StoplessLogMode = 'on' | 'off' | 'endless';

function normalizeStoplessLogMode(value: unknown): StoplessLogMode | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'on' || normalized === 'off' || normalized === 'endless') {
    return normalized;
  }
  return undefined;
}

function readPersistedStoplessLogState(stickyKey: string): {
  mode?: StoplessLogMode;
  armed?: boolean;
} {
  if (!stickyKey) {
    return {};
  }
  const state = loadRoutingInstructionStateSync(stickyKey);
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return {};
  }
  const record = state as Record<string, unknown>;
  const mode = normalizeStoplessLogMode(record.reasoningStopMode);
  return {
    ...(mode ? { mode } : {}),
    ...(typeof record.reasoningStopArmed === 'boolean'
      ? { armed: record.reasoningStopArmed }
      : {})
  };
}

function resolveStoplessLogState(metadata: Record<string, unknown>): {
  mode?: StoplessLogMode;
  armed?: boolean;
} {
  const sessionId = readString(metadata.sessionId);
  const conversationId = readString(metadata.conversationId);
  const directMode =
    normalizeStoplessLogMode(metadata.reasoningStopMode)
    ?? normalizeStoplessLogMode(metadata.stoplessMode);
  const directArmed =
    typeof metadata.reasoningStopArmed === 'boolean'
      ? metadata.reasoningStopArmed
      : (typeof metadata.stoplessArmed === 'boolean' ? metadata.stoplessArmed : undefined);
  const persistedBySession = readPersistedStoplessLogState(sessionId ? `session:${sessionId}` : '');
  const persistedByConversation = readPersistedStoplessLogState(
    conversationId ? `conversation:${conversationId}` : ''
  );
  const mode =
    directMode ??
    persistedBySession.mode ??
    persistedByConversation.mode;
  if (!mode) {
    return {};
  }
  const armed =
    directArmed ??
    persistedBySession.armed ??
    persistedByConversation.armed ??
    false;
  return { mode, armed };
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

function isServerToolFollowupRequest(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return false;
  }
  const rt =
    metadata.__rt && typeof metadata.__rt === 'object' && !Array.isArray(metadata.__rt)
      ? (metadata.__rt as Record<string, unknown>)
      : undefined;
  const raw = rt?.serverToolFollowup;
  return raw === true || (typeof raw === 'string' && raw.trim().toLowerCase() === 'true');
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
    // `resp_inbound.stage1_sse_decode` is a stable stage checkpoint even for non-stream JSON
    // responses; counting it as "SSE decode time" makes non-stream requests look like they spent
    // seconds decoding SSE when they only performed wrapper/text probes. Only explicit codec
    // decoding work should contribute decode timings.
    if (stage.includes('codec_decode')) {
      codecDecodeMs += totalMs;
    }
  }
  return { sseDecodeMs, codecDecodeMs };
}

function readQwenChatSseProbe(metadata: Record<string, unknown> | undefined): QwenChatSseProbe | undefined {
  const rt =
    metadata?.__rt && typeof metadata.__rt === 'object' && !Array.isArray(metadata.__rt)
      ? (metadata.__rt as Record<string, unknown>)
      : undefined;
  const probe =
    rt?.qwenchatSseProbe && typeof rt.qwenchatSseProbe === 'object' && !Array.isArray(rt.qwenchatSseProbe)
      ? (rt.qwenchatSseProbe as Record<string, unknown>)
      : undefined;
  if (!probe) {
    return undefined;
  }
  const out: QwenChatSseProbe = {};
  const numericKeys: Array<
    | 'firstUpstreamChunkMs'
    | 'firstDataFrameMs'
    | 'firstEmitMs'
    | 'firstToolCallMs'
    | 'upstreamDoneMs'
    | 'upstreamChunkCount'
    | 'dataFrameCount'
    | 'ignoredFrameCount'
    | 'emittedChunkCount'
  > = [
    'firstUpstreamChunkMs',
    'firstDataFrameMs',
    'firstEmitMs',
    'firstToolCallMs',
    'upstreamDoneMs',
    'upstreamChunkCount',
    'dataFrameCount',
    'ignoredFrameCount',
    'emittedChunkCount'
  ];
  for (const key of numericKeys) {
    const value = probe[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      out[key] = Math.round(value);
    }
  }
  if (typeof probe.terminalErrorCode === 'string' && probe.terminalErrorCode.trim()) {
    out.terminalErrorCode = probe.terminalErrorCode.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readQwenChatNonstreamDelivery(
  metadata: Record<string, unknown> | undefined
): QwenChatNonstreamDelivery | undefined {
  const rt =
    metadata?.__rt && typeof metadata.__rt === 'object' && !Array.isArray(metadata.__rt)
      ? (metadata.__rt as Record<string, unknown>)
      : undefined;
  const delivery =
    typeof rt?.qwenchatNonstreamDelivery === 'string'
      ? rt.qwenchatNonstreamDelivery.trim().toLowerCase()
      : '';
  if (delivery === 'json' || delivery === 'sse_fallback') {
    return delivery;
  }
  return undefined;
}

function readQwenChatNonstreamDeliveryFromBody(
  body: unknown
): QwenChatNonstreamDelivery | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return undefined;
  }
  const rawDelivery = (body as Record<string, unknown>).__routecodex_qwenchat_nonstream_delivery;
  const delivery = typeof rawDelivery === 'string' ? rawDelivery : '';
  const normalized = delivery.trim().toLowerCase();
  if (normalized === 'json' || normalized === 'sse_fallback') {
    return normalized as QwenChatNonstreamDelivery;
  }
  return undefined;
}

function formatQwenChatSseProbeTag(
  probe: QwenChatSseProbe | undefined,
  delivery?: QwenChatNonstreamDelivery
): string | undefined {
  const parts: string[] = [];
  if (delivery) {
    parts.push(`qwen.nonstream=${delivery}`);
  }
  if (!probe && parts.length === 0) {
    return undefined;
  }
  if (probe) {
    if (Number.isFinite(probe.firstUpstreamChunkMs as number)) {
      parts.push(`qwen.first_chunk=${Math.max(0, Math.round(Number(probe.firstUpstreamChunkMs)))}ms`);
    }
    if (Number.isFinite(probe.firstDataFrameMs as number)) {
      parts.push(`qwen.first_frame=${Math.max(0, Math.round(Number(probe.firstDataFrameMs)))}ms`);
    }
    if (Number.isFinite(probe.firstEmitMs as number)) {
      parts.push(`qwen.first_emit=${Math.max(0, Math.round(Number(probe.firstEmitMs)))}ms`);
    }
    if (Number.isFinite(probe.firstToolCallMs as number)) {
      parts.push(`qwen.first_tool=${Math.max(0, Math.round(Number(probe.firstToolCallMs)))}ms`);
    }
    if (Number.isFinite(probe.upstreamDoneMs as number)) {
      parts.push(`qwen.done=${Math.max(0, Math.round(Number(probe.upstreamDoneMs)))}ms`);
    }
    if (Number.isFinite(probe.upstreamChunkCount as number)) {
      parts.push(`qwen.chunks=${Math.max(0, Math.round(Number(probe.upstreamChunkCount)))}`);
    }
    if (Number.isFinite(probe.dataFrameCount as number)) {
      parts.push(`qwen.frames=${Math.max(0, Math.round(Number(probe.dataFrameCount)))}`);
    }
    if (Number.isFinite(probe.ignoredFrameCount as number)) {
      parts.push(`qwen.ignored=${Math.max(0, Math.round(Number(probe.ignoredFrameCount)))}`);
    }
    if (Number.isFinite(probe.emittedChunkCount as number)) {
      parts.push(`qwen.emitted=${Math.max(0, Math.round(Number(probe.emittedChunkCount)))}`);
    }
    if (typeof probe.terminalErrorCode === 'string' && probe.terminalErrorCode) {
      parts.push(`qwen.err=${probe.terminalErrorCode}`);
    }
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function resolveQwenChatProviderDecodeTag(options: {
  pipelineMetadata?: Record<string, unknown>;
  providerResponseBody?: unknown;
  deliveryHint?: QwenChatNonstreamDelivery;
  expectNonstreamDelivery?: boolean;
  compatibilityProfile?: string;
  providerClassName?: string;
  providerRequestedStream?: boolean;
}): string | undefined {
  const delivery =
    options.deliveryHint
    ?? readQwenChatNonstreamDelivery(options.pipelineMetadata)
    ?? readQwenChatNonstreamDeliveryFromBody(options.providerResponseBody);
  if (!delivery && options.expectNonstreamDelivery) {
    const compat = typeof options.compatibilityProfile === 'string'
      ? options.compatibilityProfile.trim()
      : '';
    const klass = typeof options.providerClassName === 'string'
      ? options.providerClassName.trim()
      : '';
    const requestedStream =
      typeof options.providerRequestedStream === 'boolean'
        ? options.providerRequestedStream
        : undefined;
    const parts = ['qwen.nonstream=missing'];
    if (compat) {
      parts.push(`qwen.compat=${compat}`);
    }
    if (klass) {
      parts.push(`qwen.class=${klass}`);
    }
    if (requestedStream !== undefined) {
      parts.push(`qwen.req_stream=${requestedStream ? 'true' : 'false'}`);
    }
    return parts.join(' ');
  }
  return formatQwenChatSseProbeTag(
    readQwenChatSseProbe(options.pipelineMetadata),
    delivery
  );
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

function cloneRequestPayloadForRetry(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  try {
    const cloned = structuredClone(payload) as unknown;
    if (cloned && typeof cloned === 'object' && !Array.isArray(cloned)) {
      return cloned as Record<string, unknown>;
    }
  } catch (error) {
    logRequestExecutorNonBlockingError('cloneRequestPayloadForRetry.structuredClone', error);
  }
  return undefined;
}

function estimateRetryPayloadBytes(
  value: unknown,
  options?: {
    maxBytes?: number;
    depth?: number;
    seen?: Set<unknown>;
    nodeBudget?: number;
    visitedNodes?: number;
  }
): number {
  const maxBytes = options?.maxBytes ?? Number.POSITIVE_INFINITY;
  const depth = options?.depth ?? 0;
  const seen = options?.seen ?? new Set<unknown>();
  const nodeBudget = options?.nodeBudget ?? RETRY_PAYLOAD_ESTIMATE_NODE_BUDGET;
  const visitedNodes = (options?.visitedNodes ?? 0) + 1;

  if (visitedNodes > nodeBudget) {
    return maxBytes + 1;
  }

  if (value === null || value === undefined) {
    return 4;
  }
  const valueType = typeof value;
  if (valueType === 'string') {
    return Math.min(maxBytes + 1, (value as string).length * 2 + 2);
  }
  if (valueType === 'number') {
    return 8;
  }
  if (valueType === 'boolean') {
    return 4;
  }
  if (valueType === 'bigint') {
    return String(value).length + 8;
  }
  if (valueType === 'symbol' || valueType === 'function') {
    return 16;
  }
  if (seen.has(value)) {
    return 8;
  }
  seen.add(value);

  if (depth >= 8) {
    return 64;
  }

  let bytes = 0;
  if (Array.isArray(value)) {
    bytes += 2;
    for (const item of value) {
      bytes += estimateRetryPayloadBytes(item, {
        maxBytes: Math.max(0, maxBytes - bytes),
        depth: depth + 1,
        seen,
        nodeBudget,
        visitedNodes
      });
      if (bytes > maxBytes) {
        return maxBytes + 1;
      }
    }
    return bytes;
  }
  if (value && typeof value === 'object') {
    bytes += 2;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      bytes += key.length * 2 + 4;
      bytes += estimateRetryPayloadBytes(child, {
        maxBytes: Math.max(0, maxBytes - bytes),
        depth: depth + 1,
        seen,
        nodeBudget,
        visitedNodes
      });
      if (bytes > maxBytes) {
        return maxBytes + 1;
      }
    }
    return bytes;
  }
  return 16;
}

function prepareRequestPayloadRetrySeed(payload: unknown): RetryPayloadSeed {
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

function restoreRequestPayloadFromRetrySeed(seed: RetryPayloadSeed): Record<string, unknown> | undefined {
  if (seed.mode === 'serialized') {
    return restoreRequestPayloadFromRetrySnapshot(seed.serializedPayload);
  }
  if (seed.mode === 'snapshot') {
    return cloneRequestPayloadForRetry(seed.snapshotPayload) ?? { ...seed.snapshotPayload };
  }
  return undefined;
}

function resolveOriginalRequestForResponseConversion(seed: RetryPayloadSeed): Record<string, unknown> | undefined {
  if (seed.mode === 'snapshot') {
    return seed.snapshotPayload;
  }
  return restoreRequestPayloadFromRetrySeed(seed);
}

function restoreRequestPayloadFromRetrySnapshot(
  serializedPayload?: string,
  fallbackPayload?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (serializedPayload && typeof serializedPayload === 'string') {
    if (serializedPayload.length > RETRY_SNAPSHOT_RESTORE_MAX_CHARS) {
      logRequestExecutorNonBlockingError(
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
      logRequestExecutorNonBlockingError('restoreRequestPayloadFromRetrySnapshot.parseSerialized', error, {
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

function isServerToolFollowupErrorCode(value: unknown): boolean {
  const normalized = normalizeCodeKey(value);
  return Boolean(normalized && normalized.startsWith('SERVERTOOL_'));
}

type RequestExecutorProviderErrorStage =
  | 'provider.runtime_resolve'
  | 'provider.send'
  | 'host.response_contract'
  | 'host.stopless_contract'
  | 'provider.followup'
  | 'provider.sse_decode'
  | 'provider.http';

type RequestExecutorProviderErrorClassification =
  | 'unrecoverable'
  | 'recoverable'
  | 'special_400';

function createClientDisconnectedAbortError(reason?: unknown): Error & { code: string; name: string; retryable?: boolean } {
  const message =
    typeof reason === 'string' && reason.trim()
      ? reason.trim()
      : reason instanceof Error && typeof reason.message === 'string' && reason.message.trim()
        ? reason.message.trim()
        : 'CLIENT_DISCONNECTED';
  return Object.assign(new Error(message), {
    code: 'CLIENT_DISCONNECTED',
    name: 'AbortError',
    retryable: false
  });
}

function throwIfClientAbortSignalAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = (signal as { reason?: unknown }).reason;
  throw reason instanceof Error ? reason : createClientDisconnectedAbortError(reason);
}

async function waitWithClientAbortSignal(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfClientAbortSignalAborted(signal);
  if (!(ms > 0)) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      const reason = (signal as { reason?: unknown }).reason;
      reject(reason instanceof Error ? reason : createClientDisconnectedAbortError(reason));
    };
    const cleanup = () => {
      clearTimeout(timer);
      try {
        signal?.removeEventListener?.('abort', onAbort as EventListener);
      } catch {
        // ignore cleanup errors
      }
    };
    try {
      signal?.addEventListener?.('abort', onAbort as EventListener, { once: true } as AddEventListenerOptions);
    } catch {
      // ignore listener registration failures
    }
  });
}

function isRequestExecutorProviderErrorStage(value: unknown): value is RequestExecutorProviderErrorStage {
  return (
    value === 'provider.runtime_resolve'
    || value === 'provider.send'
    || value === 'host.response_contract'
    || value === 'host.stopless_contract'
    || value === 'provider.followup'
    || value === 'provider.sse_decode'
    || value === 'provider.http'
  );
}

function isHostRequestExecutorErrorStage(
  stage: RequestExecutorProviderErrorStage
): stage is 'host.stopless_contract' | 'host.response_contract' {
  return stage === 'host.stopless_contract' || stage === 'host.response_contract';
}

function resolveRequestExecutorProviderErrorClassification(args: {
  error: unknown;
  retryError: RetryErrorSnapshot;
  stage?: RequestExecutorProviderErrorStage;
}): RequestExecutorProviderErrorClassification | undefined {
  const stage = args.stage;
  if (stage === 'provider.followup' || isHostRequestExecutorErrorStage(stage ?? 'provider.send')) {
    return undefined;
  }
  if (isClientDisconnectAbortError(args.error)) {
    return 'unrecoverable';
  }
  const statusCode =
    typeof args.retryError.statusCode === 'number'
      ? args.retryError.statusCode
      : extractStatusCodeFromError(args.error);
  if (statusCode === 400 && !isPromptTooLongError(args.error)) {
    return 'special_400';
  }
  const errorCode =
    normalizeCodeKey((args.error as { code?: unknown } | undefined)?.code)
    ?? normalizeCodeKey(args.retryError.errorCode);
  const upstreamCode =
    normalizeCodeKey((args.error as { upstreamCode?: unknown } | undefined)?.upstreamCode)
    ?? normalizeCodeKey(args.retryError.upstreamCode);
  const reason = String(args.retryError.reason || (args.error as { message?: string } | undefined)?.message || '')
    .trim()
    .toLowerCase();

  if (
    errorCode === 'INVALID_REQUEST_ERROR'
    || upstreamCode === 'INVALID_REQUEST_ERROR'
    || reason.includes('invalid request payload')
    || reason.includes('signature-invalid')
  ) {
    return 'special_400';
  }

  const unrecoverableCodeSet = new Set([
    'INVALID_API_KEY',
    'INVALID_ACCESS_TOKEN',
    'INSUFFICIENT_QUOTA',
    'MODEL_NOT_SUPPORTED',
    'MODEL_DISABLED',
    'NO_SUCH_MODEL',
    'ACCOUNT_DISABLED',
    'ACCOUNT_SUSPENDED',
    'ACCESS_DENIED',
    'FORBIDDEN'
  ]);
  if (typeof statusCode === 'number' && (statusCode === 401 || statusCode === 402 || statusCode === 403)) {
    return 'unrecoverable';
  }
  if (
    (errorCode && unrecoverableCodeSet.has(errorCode))
    || (upstreamCode && unrecoverableCodeSet.has(upstreamCode))
  ) {
    return 'unrecoverable';
  }
  if (
    reason.includes('invalid api key')
    || reason.includes('invalid access token')
    || reason.includes('token expired')
    || reason.includes('insufficient_quota')
    || reason.includes('quota exceeded')
    || reason.includes('model is not supported')
    || reason.includes('model not supported')
    || reason.includes('access denied')
    || reason.includes('account suspended')
    || reason.includes('account disabled')
  ) {
    return 'unrecoverable';
  }
  return 'recoverable';
}

function extractRequestExecutorProviderErrorStage(error: unknown): RequestExecutorProviderErrorStage | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const record = error as {
    requestExecutorProviderErrorStage?: unknown;
    details?: unknown;
  };
  const directStage = record.requestExecutorProviderErrorStage;
  if (isRequestExecutorProviderErrorStage(directStage)) {
    return directStage;
  }
  const details =
    record.details && typeof record.details === 'object' && !Array.isArray(record.details)
      ? (record.details as Record<string, unknown>)
      : undefined;
  const detailStage =
    details?.requestExecutorProviderErrorStage
    ?? details?.source;
  return isRequestExecutorProviderErrorStage(detailStage) ? detailStage : undefined;
}

function resolveRequestExecutorProviderErrorReportPlan(args: {
  error: unknown;
  retryError: RetryErrorSnapshot;
  fallbackStage: RequestExecutorProviderErrorStage;
}): {
  errorCode?: string;
  upstreamCode?: string;
  statusCode?: number;
  stageHint: RequestExecutorProviderErrorStage;
} {
  const errorCode =
    normalizeCodeKey((args.error as { code?: unknown } | undefined)?.code)
    ?? normalizeCodeKey(args.retryError.errorCode);
  const upstreamCode =
    normalizeCodeKey((args.error as { upstreamCode?: unknown } | undefined)?.upstreamCode)
    ?? normalizeCodeKey(args.retryError.upstreamCode);
  const statusCode =
    typeof args.retryError.statusCode === 'number'
      ? args.retryError.statusCode
      : extractStatusCodeFromError(args.error);
  const explicitStage = extractRequestExecutorProviderErrorStage(args.error);
  const stageHint: RequestExecutorProviderErrorStage =
    explicitStage
      ? explicitStage
      : (args.fallbackStage === 'provider.runtime_resolve'
      ? 'provider.runtime_resolve'
      : (args.fallbackStage === 'provider.http'
        ? 'provider.http'
        : (args.fallbackStage === 'host.response_contract'
          ? 'host.response_contract'
        : (args.fallbackStage === 'host.stopless_contract'
          ? 'host.stopless_contract'
        : (isSseDecodeRateLimitError(args.error, statusCode) || isSseDecodeRetryableNetworkError(args.error, statusCode)
          ? 'provider.sse_decode'
          : (isServerToolFollowupErrorCode(errorCode) || isServerToolFollowupErrorCode(upstreamCode)
            ? 'provider.followup'
            : args.fallbackStage))))));
  return {
    ...(errorCode ? { errorCode } : {}),
    ...(upstreamCode ? { upstreamCode } : {}),
    ...(typeof statusCode === 'number' ? { statusCode } : {}),
    stageHint
  };
}

function isHealthNeutralProviderError(args: {
  stage: RequestExecutorProviderErrorStage;
  errorCode?: string;
  upstreamCode?: string;
  statusCode?: number;
  classification?: RequestExecutorProviderErrorClassification;
}): boolean {
  if (args.stage === 'provider.followup' || isHostRequestExecutorErrorStage(args.stage)) {
    return true;
  }
  if (args.classification === 'special_400') {
    return true;
  }
  const errorCode = normalizeCodeKey(args.errorCode);
  const upstreamCode = normalizeCodeKey(args.upstreamCode);
  if (errorCode === 'CLIENT_DISCONNECTED' || upstreamCode === 'CLIENT_DISCONNECTED') {
    return true;
  }
  if (
    errorCode === 'CLIENT_TOOL_ARGS_INVALID'
    || errorCode === 'QWENCHAT_INVALID_TOOL_ARGS'
    || errorCode === 'QWENCHAT_HIDDEN_NATIVE_TOOL'
    || errorCode === 'QWENCHAT_NATIVE_TOOL_CALL'
    || upstreamCode === 'CLIENT_TOOL_ARGS_INVALID'
    || upstreamCode === 'QWENCHAT_INVALID_TOOL_ARGS'
    || upstreamCode === 'QWENCHAT_HIDDEN_NATIVE_TOOL'
    || upstreamCode === 'QWENCHAT_NATIVE_TOOL_CALL'
  ) {
    return true;
  }
  if (
    isServerToolFollowupErrorCode(errorCode)
    && typeof args.statusCode !== 'number'
    && !upstreamCode
  ) {
    return true;
  }
  if (upstreamCode === 'CLIENT_INJECT_FAILED') {
    return true;
  }
  return false;
}

function resolveReportedProviderErrorRecoverable(args: {
  stage: RequestExecutorProviderErrorStage;
  error: unknown;
  retryError: RetryErrorSnapshot;
}): boolean {
  if (args.stage === 'provider.followup' || isHostRequestExecutorErrorStage(args.stage)) {
    return false;
  }
  const classification = resolveRequestExecutorProviderErrorClassification({
    error: args.error,
    retryError: args.retryError,
    stage: args.stage
  });
  if (classification === 'special_400') {
    return false;
  }
  if (classification === 'unrecoverable') {
    return false;
  }
  if (classification === 'recoverable') {
    return true;
  }
  return shouldRetryProviderError(args.error);
}

async function reportRequestExecutorProviderError(args: {
  error: unknown;
  retryError: RetryErrorSnapshot;
  requestId: string;
  providerKey?: string;
  providerId?: string;
  providerType?: string;
  providerFamily?: string;
  providerProtocol?: string;
  routeName?: string;
  runtimeKey?: string;
  target?: Record<string, unknown>;
  dependencies: ModuleDependencies;
  attempt: number;
  logStage: (stage: string, requestId: string, details?: Record<string, unknown>) => void;
  stageHint?: RequestExecutorProviderErrorStage;
  extraDetails?: Record<string, unknown>;
}): Promise<void> {
  const reportPlan = resolveRequestExecutorProviderErrorReportPlan({
    error: args.error,
    retryError: args.retryError,
    fallbackStage: args.stageHint ?? 'provider.send'
  });
  const errorCode = reportPlan.errorCode;
  const upstreamCode = reportPlan.upstreamCode;
  const statusCode = reportPlan.statusCode;
  const stage = reportPlan.stageHint;
  const classification = resolveRequestExecutorProviderErrorClassification({
    error: args.error,
    retryError: args.retryError,
    stage
  });
  const affectsHealth = !isHealthNeutralProviderError({
    stage,
    errorCode,
    upstreamCode,
    statusCode,
    classification
  });
  if (isHostRequestExecutorErrorStage(stage)) {
    args.logStage('host.contract_failure.classified', args.requestId, {
      providerKey: args.providerKey,
      stage,
      ...(typeof statusCode === 'number' ? { statusCode } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(upstreamCode ? { upstreamCode } : {}),
      reason: args.retryError.reason,
      attempt: args.attempt
    });
    return;
  }
  try {
    const { emitProviderError } = await import('../../../providers/core/utils/provider-error-reporter.js');
    emitProviderError({
      error: args.error,
      stage,
      runtime: {
        requestId: args.requestId,
        providerKey: args.providerKey,
        providerId: args.providerId,
        providerType: args.providerType,
        providerFamily: args.providerFamily,
        providerProtocol: args.providerProtocol,
        routeName: args.routeName,
        pipelineId: args.providerKey,
        target: args.target,
        runtimeKey: args.runtimeKey
      },
      dependencies: args.dependencies,
      statusCode,
      recoverable: resolveReportedProviderErrorRecoverable({
        stage,
        error: args.error,
        retryError: args.retryError
      }),
      affectsHealth,
      details: {
        source: stage,
        ...(classification ? { errorClassification: classification } : {}),
        ...(errorCode ? { errorCode } : {}),
        ...(upstreamCode ? { upstreamCode } : {}),
        reason: args.retryError.reason,
        attempt: args.attempt,
        ...(args.extraDetails ?? {})
      }
    });
  } catch (reportError) {
    args.logStage('provider.error_reporter.failed', args.requestId, {
      providerKey: args.providerKey,
      stage,
      ...(typeof statusCode === 'number' ? { statusCode } : {}),
      message: reportError instanceof Error ? reportError.message : String(reportError ?? 'Unknown reporter error'),
      attempt: args.attempt
    });
  }
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
  providerKey?: string;
  runtimeKey?: string;
  statusCode?: number;
  errorCode?: string;
  upstreamCode?: string;
  reason?: string;
}): string {
  const providerScope = (() => {
    const raw =
      (typeof args.providerKey === 'string' && args.providerKey.trim())
      || (typeof args.runtimeKey === 'string' && args.runtimeKey.trim())
      || 'unknown';
    return `provider:${raw}`;
  })();
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
  return `${providerScope}|${statusPart}|${errorPart}|${upstreamPart}|${reasonPart}`;
}

function resolveRecoverableBackoffCapMs(args: {
  statusCode?: number;
  errorCode?: string;
  upstreamCode?: string;
  reason?: string;
}): number {
  const status = typeof args.statusCode === 'number' ? args.statusCode : undefined;
  const errorCode = normalizeCodeKey(args.errorCode);
  const upstreamCode = normalizeCodeKey(args.upstreamCode);
  const reason = typeof args.reason === 'string' ? args.reason.trim().toLowerCase() : '';
  // 429 类错误按“快速换 provider”策略：小步快跑，不做长阻塞。
  if (
    status === 429
    || errorCode === 'HTTP_429'
    || upstreamCode === 'HTTP_429'
    || errorCode === 'INSUFFICIENT_QUOTA'
    || upstreamCode === 'INSUFFICIENT_QUOTA'
    || reason.includes('insufficient_quota')
  ) {
    return process.env.NODE_ENV === 'test' ? 800 : 4_000;
  }
  return process.env.NODE_ENV === 'test' ? 5_000 : 120_000;
}

function consumeRecoverableErrorBackoffMs(
  key: string,
  args: {
    statusCode?: number;
    errorCode?: string;
    upstreamCode?: string;
    reason?: string;
  }
): number {
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
    return resolveRecoverableBackoffCapMs(args);
  })();
  return Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, consecutive - 1)));
}

function isNetworkTransportLikeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const record = error as { code?: unknown; message?: unknown; name?: unknown };
  const code = typeof record.code === 'string' ? record.code.trim().toUpperCase() : '';
  if (
    code === 'ECONNRESET'
    || code === 'ECONNREFUSED'
    || code === 'EHOSTUNREACH'
    || code === 'ENOTFOUND'
    || code === 'EAI_AGAIN'
    || code === 'EPIPE'
    || code === 'ETIMEDOUT'
    || code === 'ECONNABORTED'
  ) {
    return true;
  }
  const name = typeof record.name === 'string' ? record.name : '';
  const message = typeof record.message === 'string' ? record.message.toLowerCase() : '';
  if (name === 'AbortError' || message.includes('operation was aborted')) {
    return true;
  }
  return (
    message.includes('fetch failed')
    || message.includes('network timeout')
    || message.includes('socket hang up')
    || message.includes('client network socket disconnected')
    || message.includes('tls handshake timeout')
    || message.includes('unable to verify the first certificate')
    || message.includes('network error')
    || message.includes('temporarily unreachable')
  );
}

function resolveProviderScopedRetryBackoffCapMs(error: unknown, args: {
  statusCode?: number;
}): number {
  const status = typeof args.statusCode === 'number' ? args.statusCode : undefined;
  if (status === 429) {
    const raw = process.env.ROUTECODEX_429_BACKOFF_MAX_MS || process.env.RCC_429_BACKOFF_MAX_MS;
    const parsed = raw ? Number.parseInt(String(raw).trim(), 10) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    return process.env.NODE_ENV === 'test' ? 800 : 30_000;
  }
  if (isNetworkTransportLikeError(error)) {
    const raw =
      process.env.ROUTECODEX_NETWORK_RETRY_BACKOFF_MAX_MS
      || process.env.RCC_NETWORK_RETRY_BACKOFF_MAX_MS;
    const parsed = raw ? Number.parseInt(String(raw).trim(), 10) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    return 12_000;
  }
  const raw =
    process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_MAX_MS
    || process.env.RCC_PROVIDER_RETRY_BACKOFF_MAX_MS;
  const parsed = raw ? Number.parseInt(String(raw).trim(), 10) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return process.env.NODE_ENV === 'test' ? 15_000 : 60_000;
}

function consumeProviderScopedRetryBackoffMs(
  key: string,
  args: {
    error: unknown;
    statusCode?: number;
  }
): number {
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
    const status = typeof args.statusCode === 'number' ? args.statusCode : undefined;
    if (status === 429) {
      const raw = process.env.ROUTECODEX_429_BACKOFF_BASE_MS || process.env.RCC_429_BACKOFF_BASE_MS;
      const parsed = raw ? Number.parseInt(String(raw).trim(), 10) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
      return process.env.NODE_ENV === 'test' ? 200 : 1_000;
    }
    if (isNetworkTransportLikeError(args.error)) {
      const raw =
        process.env.ROUTECODEX_NETWORK_RETRY_BACKOFF_BASE_MS
        || process.env.RCC_NETWORK_RETRY_BACKOFF_BASE_MS;
      const parsed = raw ? Number.parseInt(String(raw).trim(), 10) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
      return 500;
    }
    const raw =
      process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS
      || process.env.RCC_PROVIDER_RETRY_BACKOFF_BASE_MS;
    const parsed = raw ? Number.parseInt(String(raw).trim(), 10) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    return process.env.NODE_ENV === 'test' ? 800 : 2_000;
  })();
  const maxMs = resolveProviderScopedRetryBackoffCapMs(args.error, {
    statusCode: args.statusCode
  });
  return Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, consecutive - 1)));
}

type ProviderRetryBackoffPlan = {
  blockingRecoverable: boolean;
  retryBackoffMs: number;
  recoverableBackoffMs: number;
  backoffScope: 'provider' | 'recoverable' | 'attempt';
};

type ProviderRetrySwitchAction = 'exclude_and_reroute' | 'retry_same_provider';

type ProviderRetryBackoffScope = ProviderRetryBackoffPlan['backoffScope'];

type ProviderRetrySwitchPlan = {
  switchAction: ProviderRetrySwitchAction;
  decisionLabel: string;
  runtimeScopeExcluded: string[];
  runtimeScopeExcludedCount: number;
};

type ProviderRetryExclusionPlan = {
  excludedCurrentProvider: boolean;
  antigravityRetrySignal: AntigravityRetrySignal | null;
};

type ProviderRetryEligibilityPlan = {
  shouldRetry: boolean;
  blockingRecoverable: boolean;
};

type ProviderRetryExecutionPlan = {
  shouldRetry: boolean;
  blockingRecoverable: boolean;
  excludedCurrentProvider: boolean;
  retryBackoffMs: number;
  recoverableBackoffMs: number;
  backoffScope?: ProviderRetryBackoffScope;
  retrySwitchPlan?: ProviderRetrySwitchPlan;
  antigravityRetrySignal: AntigravityRetrySignal | null;
};

type ProviderRetryTelemetryPlan = {
  switchLogArgs: {
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
    switchAction: ProviderRetrySwitchAction;
    backoffScope?: ProviderRetryBackoffScope;
    decisionLabel?: string;
    stage?: 'provider.runtime_resolve' | 'provider.send';
    runtimeScopeExcludedCount?: number;
  };
  retryStageDetails: Record<string, unknown>;
  runtimeScopeExcludeDetails?: Record<string, unknown>;
};

type ExcludedProviderReselectionPlan = {
  hasAlternativeCandidate: boolean;
  keepExcludedForNextAttempt: boolean;
};

type RequestExecutorProviderFailurePlan = {
  reportPlan: {
    errorCode?: string;
    upstreamCode?: string;
    statusCode?: number;
    stageHint: RequestExecutorProviderErrorStage;
  };
  retryExecutionPlan: ProviderRetryExecutionPlan;
  retryTelemetryPlan?: ProviderRetryTelemetryPlan;
};

function describeProviderRetryDecision(args: {
  switchAction: ProviderRetrySwitchAction;
  backoffScope: ProviderRetryBackoffScope;
}): string {
  if (args.switchAction === 'exclude_and_reroute') {
    if (args.backoffScope === 'provider') {
      return 'provider_backoff_then_reroute';
    }
    if (args.backoffScope === 'recoverable') {
      return 'recoverable_backoff_then_reroute';
    }
    return 'attempt_backoff_then_reroute';
  }
  if (args.backoffScope === 'provider') {
    return 'provider_backoff_same_provider';
  }
  if (args.backoffScope === 'recoverable') {
    return 'recoverable_backoff_same_provider';
  }
  return 'attempt_backoff_same_provider';
}

function resolveProviderRetryEligibilityPlan(args: {
  error: unknown;
  retryError: RetryErrorSnapshot;
  attempt: number;
  maxAttempts: number;
  stage?: RequestExecutorProviderErrorStage;
  providerKey?: string;
  promptTooLong?: boolean;
  contextOverflowRetries?: number;
  maxContextOverflowRetries?: number;
  isVerify?: boolean;
  isReauth?: boolean;
  allowAntigravityRecovery?: boolean;
}): ProviderRetryEligibilityPlan {
  const classification = resolveRequestExecutorProviderErrorClassification({
    error: args.error,
    retryError: args.retryError,
    stage: args.stage
  });
  const antigravityRecoveryEligible =
    args.allowAntigravityRecovery
    && isAntigravityProviderKey(args.providerKey)
    && (args.isVerify || args.isReauth);
  const blockingRecoverable = isBlockingRecoverableRetryError({
    statusCode: args.retryError.statusCode,
    errorCode: args.retryError.errorCode,
    upstreamCode: args.retryError.upstreamCode,
    reason: args.retryError.reason
  });
  if (args.stage === 'provider.followup') {
    return { shouldRetry: false, blockingRecoverable };
  }
  if (classification === 'special_400') {
    return { shouldRetry: false, blockingRecoverable: false };
  }
  if (!(args.attempt < args.maxAttempts)) {
    return { shouldRetry: false, blockingRecoverable };
  }
  if (classification === 'unrecoverable') {
    return {
      shouldRetry: shouldRetryProviderError(args.error) || Boolean(antigravityRecoveryEligible),
      blockingRecoverable: false
    };
  }
  if (args.promptTooLong) {
    return {
      shouldRetry:
        (args.contextOverflowRetries ?? 0) < (args.maxContextOverflowRetries ?? MAX_CONTEXT_OVERFLOW_RETRIES),
      blockingRecoverable: false
    };
  }
  if (blockingRecoverable) {
    return {
      shouldRetry: shouldRetryProviderError(args.error),
      blockingRecoverable
    };
  }
  return {
    shouldRetry: shouldRetryProviderError(args.error) || Boolean(antigravityRecoveryEligible),
    blockingRecoverable
  };
}

async function resolveProviderRetryExecutionPlan(args: {
  error: unknown;
  retryError: RetryErrorSnapshot;
  attempt: number;
  maxAttempts: number;
  stage?: RequestExecutorProviderErrorStage;
  providerKey?: string;
  runtimeKey?: string;
  logicalRequestChainKey: string;
  logicalChainRetryLimitStageRequestId: string;
  routePool?: string[];
  runtimeManager?: RequestExecutorDeps['runtimeManager'];
  excludedProviderKeys: Set<string>;
  recordAttempt: (args: { error: boolean }) => void;
  logStage: (stage: string, requestId: string, details?: Record<string, unknown>) => void;
  promptTooLong?: boolean;
  contextOverflowRetries?: number;
  maxContextOverflowRetries?: number;
  isVerify?: boolean;
  isReauth?: boolean;
  allowAntigravityRecovery?: boolean;
  antigravityRetrySignal?: AntigravityRetrySignal | null;
  status?: number;
  forceExcludeCurrentProviderOnRetry?: boolean;
  abortSignal?: AbortSignal;
}): Promise<ProviderRetryExecutionPlan> {
  const hostContractFailure = isHostRequestExecutorErrorStage(args.stage ?? 'provider.send');
  const rerouteHostContractFailure = args.stage === 'host.stopless_contract';
  const classification = resolveRequestExecutorProviderErrorClassification({
    error: args.error,
    retryError: args.retryError,
    stage: args.stage
  });
  const eligibilityPlan = resolveProviderRetryEligibilityPlan({
    error: args.error,
    retryError: args.retryError,
    attempt: args.attempt,
    maxAttempts: args.maxAttempts,
    stage: args.stage,
    providerKey: args.providerKey,
    promptTooLong: args.promptTooLong,
    contextOverflowRetries: args.contextOverflowRetries,
    maxContextOverflowRetries: args.maxContextOverflowRetries,
    isVerify: args.isVerify,
    isReauth: args.isReauth,
    allowAntigravityRecovery: args.allowAntigravityRecovery
  });
  args.recordAttempt({ error: true });
  if (!eligibilityPlan.shouldRetry) {
    return {
      shouldRetry: false,
      blockingRecoverable: eligibilityPlan.blockingRecoverable,
      excludedCurrentProvider: false,
      retryBackoffMs: 0,
      recoverableBackoffMs: 0,
      antigravityRetrySignal: args.antigravityRetrySignal ?? null
    };
  }
  const exclusionPlan = hostContractFailure
    ? {
      excludedCurrentProvider: rerouteHostContractFailure
        ? applyRetryExclusionForCurrentProvider({
          providerKey: args.providerKey,
          excludedProviderKeys: args.excludedProviderKeys
        })
        : false,
      antigravityRetrySignal: args.antigravityRetrySignal ?? null
    }
    : args.forceExcludeCurrentProviderOnRetry
    ? {
      excludedCurrentProvider: applyRetryExclusionForCurrentProvider({
        providerKey: args.providerKey,
        excludedProviderKeys: args.excludedProviderKeys
      }),
      antigravityRetrySignal: args.antigravityRetrySignal ?? null
    }
    : resolveProviderRetryExclusionPlan({
      providerKey: args.providerKey,
      status: args.status,
      error: args.error,
      promptTooLong: Boolean(args.promptTooLong),
      isVerify: Boolean(args.isVerify),
      isReauth: Boolean(args.isReauth),
      antigravityRetrySignal: args.antigravityRetrySignal ?? null,
      excludedProviderKeys: args.excludedProviderKeys
    });
  if (
    classification === 'unrecoverable'
    && !exclusionPlan.excludedCurrentProvider
    && (args.error as { retryable?: unknown } | undefined)?.retryable !== true
  ) {
    return {
      shouldRetry: false,
      blockingRecoverable: eligibilityPlan.blockingRecoverable,
      excludedCurrentProvider: false,
      retryBackoffMs: 0,
      recoverableBackoffMs: 0,
      antigravityRetrySignal: exclusionPlan.antigravityRetrySignal
    };
  }
  const retryBackoffPlan = await resolveProviderRetryBackoffPlan({
    error: args.error,
    retryError: args.retryError,
    providerKey: args.providerKey,
    runtimeKey: args.runtimeKey,
    logicalRequestChainKey: args.logicalRequestChainKey,
    logicalChainRetryLimitStageRequestId: args.logicalChainRetryLimitStageRequestId,
    attempt: args.attempt,
    forceProviderScopedBackoff: exclusionPlan.excludedCurrentProvider,
    forceAttemptScopedBackoff: hostContractFailure && !exclusionPlan.excludedCurrentProvider,
    abortSignal: args.abortSignal,
    logStage: args.logStage
  });
  const retrySwitchPlan = resolveProviderRetrySwitchPlan({
    runtimeKey: args.runtimeKey,
    routePool: args.routePool,
    runtimeManager: args.runtimeManager,
    excludedProviderKeys: args.excludedProviderKeys,
    excludedCurrentProvider: exclusionPlan.excludedCurrentProvider,
    promptTooLong: args.promptTooLong,
    error: args.error,
    retryError: args.retryError,
    backoffScope: retryBackoffPlan.backoffScope
  });
  if (
    classification === 'unrecoverable'
    && retrySwitchPlan.switchAction === 'exclude_and_reroute'
    && !hasAlternativeRouteCandidate({
      providerKey: args.providerKey,
      routePool: args.routePool,
      excludedProviderKeys: args.excludedProviderKeys
    })
  ) {
    return {
      shouldRetry: false,
      blockingRecoverable: eligibilityPlan.blockingRecoverable,
      excludedCurrentProvider: exclusionPlan.excludedCurrentProvider,
      retryBackoffMs: 0,
      recoverableBackoffMs: 0,
      antigravityRetrySignal: exclusionPlan.antigravityRetrySignal
    };
  }
  return {
    shouldRetry: true,
    blockingRecoverable: eligibilityPlan.blockingRecoverable,
    excludedCurrentProvider: exclusionPlan.excludedCurrentProvider,
    retryBackoffMs: retryBackoffPlan.retryBackoffMs,
    recoverableBackoffMs: retryBackoffPlan.recoverableBackoffMs,
    backoffScope: retryBackoffPlan.backoffScope,
    retrySwitchPlan,
    antigravityRetrySignal: exclusionPlan.antigravityRetrySignal
  };
}

function hasAlternativeRouteCandidate(args: {
  providerKey?: string;
  routePool?: string[];
  excludedProviderKeys: Set<string>;
}): boolean {
  const currentProviderKey = readString(args.providerKey);
  if (!Array.isArray(args.routePool) || args.routePool.length === 0) {
    return true;
  }
  return args.routePool.some((candidate) => {
    const normalized = readString(candidate);
    if (!normalized) {
      return false;
    }
    if (currentProviderKey && normalized === currentProviderKey) {
      return false;
    }
    return !args.excludedProviderKeys.has(normalized);
  });
}

function resolveExcludedProviderReselectionPlan(args: {
  providerKey?: string;
  routePool?: string[];
  excludedProviderKeys: Set<string>;
  lastError?: unknown;
}): ExcludedProviderReselectionPlan {
  const hasAlternativeCandidate = hasAlternativeRouteCandidate({
    providerKey: args.providerKey,
    routePool: args.routePool,
    excludedProviderKeys: args.excludedProviderKeys
  });
  const classification =
    args.lastError
      ? resolveRequestExecutorProviderErrorClassification({
        error: args.lastError,
        retryError: extractRetryErrorSnapshot(args.lastError),
        stage: 'provider.send'
      })
      : undefined;
  return {
    hasAlternativeCandidate,
    keepExcludedForNextAttempt: classification === 'unrecoverable' || hasAlternativeCandidate
  };
}

async function resolveRequestExecutorProviderFailurePlan(args: {
  error: unknown;
  retryError: RetryErrorSnapshot;
  requestId: string;
  providerKey?: string;
  providerId?: string;
  providerType?: string;
  providerFamily?: string;
  providerProtocol?: string;
  routeName?: string;
  runtimeKey?: string;
  target?: Record<string, unknown>;
  dependencies: ModuleDependencies;
  attempt: number;
  maxAttempts: number;
  stage: 'provider.runtime_resolve' | 'provider.send';
  logicalRequestChainKey: string;
  logicalChainRetryLimitStageRequestId: string;
  routePool?: string[];
  runtimeManager?: RequestExecutorDeps['runtimeManager'];
  excludedProviderKeys: Set<string>;
  recordAttempt: (args: { error: boolean }) => void;
  logStage: (stage: string, requestId: string, details?: Record<string, unknown>) => void;
  routeHint?: string;
  promptTooLong?: boolean;
  contextOverflowRetries?: number;
  maxContextOverflowRetries?: number;
  isVerify?: boolean;
  isReauth?: boolean;
  allowAntigravityRecovery?: boolean;
  antigravityRetrySignal?: AntigravityRetrySignal | null;
  status?: number;
  forceExcludeCurrentProviderOnRetry?: boolean;
  abortSignal?: AbortSignal;
}): Promise<RequestExecutorProviderFailurePlan> {
  const reportPlan = resolveRequestExecutorProviderErrorReportPlan({
    error: args.error,
    retryError: args.retryError,
    fallbackStage: args.stage
  });
  await reportRequestExecutorProviderError({
    error: args.error,
    retryError: args.retryError,
    requestId: args.requestId,
    providerKey: args.providerKey,
    providerId: args.providerId,
    providerType: args.providerType,
    providerFamily: args.providerFamily,
    providerProtocol: args.providerProtocol,
    routeName: args.routeName,
    runtimeKey: args.runtimeKey,
    target: args.target,
    dependencies: args.dependencies,
    attempt: args.attempt,
    logStage: args.logStage,
    stageHint: reportPlan.stageHint
  });
  const retryExecutionPlan = await resolveProviderRetryExecutionPlan({
    error: args.error,
    retryError: args.retryError,
    attempt: args.attempt,
    maxAttempts: args.maxAttempts,
    stage: reportPlan.stageHint,
    providerKey: args.providerKey,
    runtimeKey: args.runtimeKey,
    logicalRequestChainKey: args.logicalRequestChainKey,
    logicalChainRetryLimitStageRequestId: args.logicalChainRetryLimitStageRequestId,
    routePool: args.routePool,
    runtimeManager: args.runtimeManager,
    excludedProviderKeys: args.excludedProviderKeys,
    recordAttempt: args.recordAttempt,
    logStage: args.logStage,
    promptTooLong: args.promptTooLong,
    contextOverflowRetries: args.contextOverflowRetries,
    maxContextOverflowRetries: args.maxContextOverflowRetries,
    isVerify: args.isVerify,
    isReauth: args.isReauth,
    allowAntigravityRecovery: args.allowAntigravityRecovery,
    antigravityRetrySignal: args.antigravityRetrySignal,
    status: args.status,
    forceExcludeCurrentProviderOnRetry: args.forceExcludeCurrentProviderOnRetry,
    abortSignal: args.abortSignal
  });
  const retryTelemetryPlan =
    retryExecutionPlan.shouldRetry && retryExecutionPlan.retrySwitchPlan && retryExecutionPlan.backoffScope
      ? buildProviderRetryTelemetryPlan({
        requestId: args.requestId,
        attempt: args.attempt,
        maxAttempts: args.maxAttempts,
        providerKey: args.providerKey,
        retryError: args.retryError,
        excludedProviderKeys: args.excludedProviderKeys,
        routeHint: args.routeHint,
        retryExecutionPlan,
        stage: args.stage,
        runtimeKey: args.runtimeKey,
        promptTooLong: args.promptTooLong,
        contextOverflowRetries: args.contextOverflowRetries,
        maxContextOverflowRetries: args.maxContextOverflowRetries
      })
      : undefined;
  return {
    reportPlan,
    retryExecutionPlan,
    ...(retryTelemetryPlan ? { retryTelemetryPlan } : {})
  };
}

function emitRequestExecutorProviderRetryTelemetry(args: {
  requestId: string;
  retryTelemetryPlan: ProviderRetryTelemetryPlan;
  logStage: (stage: string, requestId: string, details?: Record<string, unknown>) => void;
  logProviderRetrySwitch: (args: ProviderRetryTelemetryPlan['switchLogArgs']) => void;
}): void {
  if (args.retryTelemetryPlan.runtimeScopeExcludeDetails) {
    args.logStage('provider.retry.runtime_scope_exclude', args.requestId, args.retryTelemetryPlan.runtimeScopeExcludeDetails);
  }
  args.logProviderRetrySwitch(args.retryTelemetryPlan.switchLogArgs);
  args.logStage('provider.retry', args.requestId, args.retryTelemetryPlan.retryStageDetails);
}

function buildProviderRetryTelemetryPlan(args: {
  requestId: string;
  attempt: number;
  maxAttempts: number;
  providerKey?: string;
  retryError: RetryErrorSnapshot;
  excludedProviderKeys: Set<string>;
  routeHint?: string;
  retryExecutionPlan: ProviderRetryExecutionPlan;
  stage: 'provider.runtime_resolve' | 'provider.send';
  runtimeKey?: string;
  promptTooLong?: boolean;
  contextOverflowRetries?: number;
  maxContextOverflowRetries?: number;
}): ProviderRetryTelemetryPlan {
  if (!args.retryExecutionPlan.retrySwitchPlan || !args.retryExecutionPlan.backoffScope) {
    throw new Error('retry telemetry requires retrySwitchPlan/backoffScope');
  }
  const retrySwitchPlan = args.retryExecutionPlan.retrySwitchPlan;
  const nextAttempt = Math.min(args.maxAttempts, args.attempt + 1);
  const switchLogArgs = {
    requestId: args.requestId,
    attempt: args.attempt,
    maxAttempts: args.maxAttempts,
    providerKey: args.providerKey,
    nextAttempt,
    reason: args.retryError.reason,
    backoffMs: args.retryExecutionPlan.retryBackoffMs,
    statusCode: args.retryError.statusCode,
    errorCode: args.retryError.errorCode,
    upstreamCode: args.retryError.upstreamCode,
    switchAction: retrySwitchPlan.switchAction,
    backoffScope: args.retryExecutionPlan.backoffScope,
    decisionLabel: retrySwitchPlan.decisionLabel,
    stage: args.stage,
    runtimeScopeExcludedCount: retrySwitchPlan.runtimeScopeExcludedCount
  } as ProviderRetryTelemetryPlan['switchLogArgs'];
  const retryStageDetails: Record<string, unknown> = {
    providerKey: args.providerKey,
    attempt: args.attempt,
    nextAttempt,
    excluded: Array.from(args.excludedProviderKeys),
    reason: args.retryError.reason,
    routeHint: args.routeHint,
    switchAction: retrySwitchPlan.switchAction,
    ...(typeof args.retryError.statusCode === 'number' ? { statusCode: args.retryError.statusCode } : {}),
    ...(args.retryError.errorCode ? { errorCode: args.retryError.errorCode } : {}),
    ...(args.retryError.upstreamCode ? { upstreamCode: args.retryError.upstreamCode } : {}),
    retryBackoffMs: args.retryExecutionPlan.retryBackoffMs,
    recoverableBackoffMs: args.retryExecutionPlan.recoverableBackoffMs,
    backoffScope: args.retryExecutionPlan.backoffScope,
    decisionLabel: retrySwitchPlan.decisionLabel,
    ...(retrySwitchPlan.runtimeScopeExcludedCount > 0
      ? { runtimeScopeExcludedCount: retrySwitchPlan.runtimeScopeExcludedCount }
      : {}),
    holdOnLastAvailable429: false,
    blockingRecoverable: args.retryExecutionPlan.blockingRecoverable,
    ...(args.promptTooLong
      ? {
        contextOverflowRetries: args.contextOverflowRetries,
        maxContextOverflowRetries: args.maxContextOverflowRetries
      }
      : {})
  };
  const runtimeScopeExcludeDetails = retrySwitchPlan.runtimeScopeExcluded.length > 0
    ? {
      providerKey: args.providerKey,
      runtimeKey: args.runtimeKey,
      excludedRuntimeScope: retrySwitchPlan.runtimeScopeExcluded,
      attempt: args.attempt
    }
    : undefined;
  return {
    switchLogArgs,
    retryStageDetails,
    runtimeScopeExcludeDetails
  };
}

async function resolveProviderRetryBackoffPlan(args: {
  error: unknown;
  retryError: RetryErrorSnapshot;
  providerKey?: string;
  runtimeKey?: string;
  logicalRequestChainKey: string;
  logicalChainRetryLimitStageRequestId: string;
  attempt: number;
  forceProviderScopedBackoff?: boolean;
  forceAttemptScopedBackoff?: boolean;
  abortSignal?: AbortSignal;
  logStage: (stage: string, requestId: string, details?: Record<string, unknown>) => void;
}): Promise<ProviderRetryBackoffPlan> {
  const blockingRecoverable = isBlockingRecoverableRetryError({
    statusCode: args.retryError.statusCode,
    errorCode: args.retryError.errorCode,
    upstreamCode: args.retryError.upstreamCode,
    reason: args.retryError.reason
  });
  if (args.forceAttemptScopedBackoff) {
    const retryBackoffMs = await waitBeforeRetry(args.error, {
      attempt: args.attempt,
      signal: args.abortSignal
    });
    return {
      blockingRecoverable,
      retryBackoffMs,
      recoverableBackoffMs: 0,
      backoffScope: 'attempt'
    };
  }
  if (args.forceProviderScopedBackoff) {
    const providerScopedKey = buildRecoverableErrorBackoffKey({
      providerKey: args.providerKey,
      runtimeKey: args.runtimeKey,
      statusCode: args.retryError.statusCode,
      errorCode: args.retryError.errorCode,
      upstreamCode: args.retryError.upstreamCode,
      reason: args.retryError.reason
    });
    const retryBackoffMs = consumeProviderScopedRetryBackoffMs(providerScopedKey, {
      error: args.error,
      statusCode: args.retryError.statusCode
    });
    await waitRecoverableBackoffWithGlobalGate(providerScopedKey, retryBackoffMs, args.abortSignal);
    return {
      blockingRecoverable,
      retryBackoffMs,
      recoverableBackoffMs: 0,
      backoffScope: 'provider'
    };
  }
  if (!blockingRecoverable) {
    const retryBackoffMs = await waitBeforeRetry(args.error, {
      attempt: args.attempt,
      signal: args.abortSignal
    });
    return {
      blockingRecoverable,
      retryBackoffMs,
      recoverableBackoffMs: 0,
      backoffScope: 'attempt'
    };
  }

  const logicalChainRetry = consumeLogicalChainRecoverableRetry(args.logicalRequestChainKey);
  if (!logicalChainRetry.allowed) {
    args.logStage('provider.retry.logical_chain_limit_hit', args.logicalChainRetryLimitStageRequestId, {
      providerKey: args.providerKey,
      logicalRequestChainKey: args.logicalRequestChainKey,
      logicalChainRecoverableRetries: logicalChainRetry.count,
      logicalChainRecoverableRetryLimit: logicalChainRetry.limit,
      attempt: args.attempt,
      ...(typeof args.retryError.statusCode === 'number' ? { statusCode: args.retryError.statusCode } : {}),
      ...(args.retryError.errorCode ? { errorCode: args.retryError.errorCode } : {}),
      ...(args.retryError.upstreamCode ? { upstreamCode: args.retryError.upstreamCode } : {}),
      reason: args.retryError.reason
    });
    throw args.error;
  }

  const recoverableKey = buildRecoverableErrorBackoffKey({
    providerKey: args.providerKey,
    runtimeKey: args.runtimeKey,
    statusCode: args.retryError.statusCode,
    errorCode: args.retryError.errorCode,
    upstreamCode: args.retryError.upstreamCode,
    reason: args.retryError.reason
  });
  const recoverableBackoffMs = consumeRecoverableErrorBackoffMs(recoverableKey, {
    statusCode: args.retryError.statusCode,
    errorCode: args.retryError.errorCode,
    upstreamCode: args.retryError.upstreamCode,
    reason: args.retryError.reason
  });
  await waitRecoverableBackoffWithGlobalGate(recoverableKey, recoverableBackoffMs, args.abortSignal);
  return {
    blockingRecoverable,
    retryBackoffMs: recoverableBackoffMs,
    recoverableBackoffMs,
    backoffScope: 'recoverable'
  };
}

function resolveProviderRetrySwitchPlan(args: {
  runtimeKey?: string;
  routePool?: string[];
  runtimeManager?: RequestExecutorDeps['runtimeManager'];
  excludedProviderKeys: Set<string>;
  excludedCurrentProvider: boolean;
  promptTooLong?: boolean;
  error?: unknown;
  retryError?: RetryErrorSnapshot;
  backoffScope: ProviderRetryBackoffScope;
}): ProviderRetrySwitchPlan {
  const switchAction: ProviderRetrySwitchAction =
    args.excludedCurrentProvider ? 'exclude_and_reroute' : 'retry_same_provider';
  let runtimeScopeExcluded: string[] = [];
  const isProviderTrafficSaturated =
    args.retryError?.errorCode === 'PROVIDER_TRAFFIC_SATURATED'
    || (typeof (args.error as { code?: unknown } | undefined)?.code === 'string'
      && (args.error as { code?: string }).code === 'PROVIDER_TRAFFIC_SATURATED');
  if (
    !args.promptTooLong
    && args.excludedCurrentProvider
    && isProviderTrafficSaturated
    && Array.isArray(args.routePool)
    && args.routePool.length > 0
    && args.runtimeManager
  ) {
    runtimeScopeExcluded = excludeProvidersSharingRuntimeFromRoutePool({
      routePool: args.routePool,
      runtimeKey: args.runtimeKey ?? '',
      runtimeManager: args.runtimeManager,
      excludedProviderKeys: args.excludedProviderKeys
    });
  }
  return {
    switchAction,
    decisionLabel: describeProviderRetryDecision({
      switchAction,
      backoffScope: args.backoffScope
    }),
    runtimeScopeExcluded,
    runtimeScopeExcludedCount: runtimeScopeExcluded.length
  };
}

async function waitRecoverableBackoffMs(ms: number, signal?: AbortSignal): Promise<void> {
  await waitWithClientAbortSignal(ms, signal);
}

function resolveRecoverableBackoffMaxWaiters(): number {
  const raw =
    process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_WAITERS
    ?? process.env.RCC_RECOVERABLE_BACKOFF_MAX_WAITERS
    ?? '';
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (Number.isFinite(parsed) && parsed >= 1) {
    return parsed;
  }
  return 64;
}

function acquireRecoverableWaiterSlot(key: string): { key: string; activeWaiters: number } {
  const normalizedKey = key.trim() || 'recoverable:unknown';
  const now = Date.now();
  for (const [existingKey, state] of recoverableRetryWaiterState.entries()) {
    if (state.activeWaiters <= 0 || now - state.updatedAtMs >= RECOVERABLE_BACKOFF_TTL_MS) {
      recoverableRetryWaiterState.delete(existingKey);
    }
  }
  const current = recoverableRetryWaiterState.get(normalizedKey);
  const nextActiveWaiters = (current?.activeWaiters ?? 0) + 1;
  const maxWaiters = resolveRecoverableBackoffMaxWaiters();
  if (nextActiveWaiters > maxWaiters) {
    throw Object.assign(
      new Error(`recoverable retry waiters overloaded for key ${normalizedKey}`),
      {
        statusCode: 429,
        code: 'PROVIDER_TRAFFIC_SATURATED',
        retryable: true,
        details: {
          reason: 'recoverable_waiter_overload',
          recoverableKey: normalizedKey,
          activeWaiters: current?.activeWaiters ?? 0,
          maxWaiters
        }
      }
    );
  }
  recoverableRetryWaiterState.set(normalizedKey, {
    activeWaiters: nextActiveWaiters,
    updatedAtMs: now
  });
  return {
    key: normalizedKey,
    activeWaiters: nextActiveWaiters
  };
}

function releaseRecoverableWaiterSlot(key: string): void {
  const normalizedKey = key.trim() || 'recoverable:unknown';
  const current = recoverableRetryWaiterState.get(normalizedKey);
  if (!current) {
    return;
  }
  const nextActiveWaiters = Math.max(0, current.activeWaiters - 1);
  if (nextActiveWaiters === 0) {
    recoverableRetryWaiterState.delete(normalizedKey);
    return;
  }
  recoverableRetryWaiterState.set(normalizedKey, {
    activeWaiters: nextActiveWaiters,
    updatedAtMs: Date.now()
  });
}

async function waitRecoverableBackoffWithGlobalGate(key: string, ms: number, signal?: AbortSignal): Promise<void> {
  const waiter = acquireRecoverableWaiterSlot(key);
  const normalizedKey = waiter.key;
  const previous = recoverableRetryGateState.get(normalizedKey) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  recoverableRetryGateState.set(normalizedKey, current);
  try {
    await previous.catch(() => undefined);
    await waitRecoverableBackoffMs(ms, signal);
  } finally {
    release();
    if (recoverableRetryGateState.get(normalizedKey) === current) {
      recoverableRetryGateState.delete(normalizedKey);
    }
    releaseRecoverableWaiterSlot(normalizedKey);
  }
}

function deriveLogicalRequestChainKey(requestId: string): string {
  const normalized = typeof requestId === 'string' ? requestId.trim() : '';
  if (!normalized) {
    return 'request-chain:unknown';
  }
  const root = normalized.split(':')[0]?.trim() || normalized;
  return root || 'request-chain:unknown';
}

function resolveLogicalChainRecoverableRetryLimit(): number {
  const raw =
    process.env.ROUTECODEX_LOGICAL_CHAIN_RECOVERABLE_RETRY_LIMIT
    ?? process.env.RCC_LOGICAL_CHAIN_RECOVERABLE_RETRY_LIMIT
    ?? '';
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (Number.isFinite(parsed) && parsed >= 1) {
    return parsed;
  }
  return 8;
}

function retainLogicalRequestChain(key: string): string {
  const normalizedKey = key.trim() || 'request-chain:unknown';
  const now = Date.now();
  for (const [existingKey, state] of logicalChainRetryState.entries()) {
    if (state.activeExecutions <= 0 && now - state.updatedAtMs >= RECOVERABLE_BACKOFF_TTL_MS) {
      logicalChainRetryState.delete(existingKey);
    }
  }
  const current = logicalChainRetryState.get(normalizedKey);
  logicalChainRetryState.set(normalizedKey, {
    recoverableRetries: current?.recoverableRetries ?? 0,
    updatedAtMs: now,
    activeExecutions: (current?.activeExecutions ?? 0) + 1
  });
  return normalizedKey;
}

function releaseLogicalRequestChain(key: string): void {
  const current = logicalChainRetryState.get(key);
  if (!current) {
    return;
  }
  const nextActiveExecutions = Math.max(0, current.activeExecutions - 1);
  if (nextActiveExecutions === 0) {
    logicalChainRetryState.delete(key);
    return;
  }
  logicalChainRetryState.set(key, {
    ...current,
    activeExecutions: nextActiveExecutions,
    updatedAtMs: Date.now()
  });
}

function consumeLogicalChainRecoverableRetry(key: string): {
  allowed: boolean;
  count: number;
  limit: number;
} {
  const normalizedKey = key.trim() || 'request-chain:unknown';
  const limit = resolveLogicalChainRecoverableRetryLimit();
  const current = logicalChainRetryState.get(normalizedKey) ?? {
    recoverableRetries: 0,
    updatedAtMs: 0,
    activeExecutions: 0
  };
  const count = current.recoverableRetries + 1;
  const next = {
    ...current,
    recoverableRetries: count,
    updatedAtMs: Date.now()
  };
  logicalChainRetryState.set(normalizedKey, next);
  return {
    allowed: count <= limit,
    count,
    limit
  };
}

function resetRequestExecutorInternalStateForTests(): void {
  nonBlockingLogState.clear();
  requestDegradedLogState.clear();
  recoverableErrorBackoffState.clear();
  recoverableRetryGateState.clear();
  recoverableRetryWaiterState.clear();
  logicalChainRetryState.clear();
  providerSwitchLogState.clear();
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

function applyRetryExclusionForCurrentProvider(args: {
  providerKey?: string;
  excludedProviderKeys: Set<string>;
}): boolean {
  const providerKey = readString(args.providerKey);
  if (!providerKey) {
    return false;
  }
  args.excludedProviderKeys.add(providerKey);
  return true;
}

function resolveProviderRetryExclusionPlan(args: {
  providerKey?: string;
  status?: number;
  error: unknown;
  promptTooLong: boolean;
  isVerify: boolean;
  isReauth: boolean;
  antigravityRetrySignal: AntigravityRetrySignal | null;
  excludedProviderKeys: Set<string>;
}): ProviderRetryExclusionPlan {
  const providerKey = readString(args.providerKey);
  let nextAntigravityRetrySignal = args.antigravityRetrySignal;
  if (!providerKey) {
    return {
      excludedCurrentProvider: false,
      antigravityRetrySignal: nextAntigravityRetrySignal
    };
  }
  if (args.promptTooLong) {
    return {
      excludedCurrentProvider: applyRetryExclusionForCurrentProvider({
        providerKey,
        excludedProviderKeys: args.excludedProviderKeys
      }),
      antigravityRetrySignal: nextAntigravityRetrySignal
    };
  }
  const isAntigravity = isAntigravityProviderKey(providerKey);
  const is429 = args.status === 429;
  if (isAntigravity && (args.isVerify || is429)) {
    const excludedCurrentProvider = applyRetryExclusionForCurrentProvider({
      providerKey,
      excludedProviderKeys: args.excludedProviderKeys
    });
    nextAntigravityRetrySignal = nextAntigravityRetrySignal
      ? { ...nextAntigravityRetrySignal, avoidAllOnRetry: true }
      : { signature: extractRetryErrorSignature(args.error), consecutive: 1, avoidAllOnRetry: true };
    return {
      excludedCurrentProvider,
      antigravityRetrySignal: nextAntigravityRetrySignal
    };
  }
  if (isAntigravity && args.isReauth) {
    return {
      excludedCurrentProvider: applyRetryExclusionForCurrentProvider({
        providerKey,
        excludedProviderKeys: args.excludedProviderKeys
      }),
      antigravityRetrySignal: nextAntigravityRetrySignal
    };
  }
  if (!isAntigravity || shouldRotateAntigravityAliasOnRetry(args.error)) {
    return {
      excludedCurrentProvider: applyRetryExclusionForCurrentProvider({
        providerKey,
        excludedProviderKeys: args.excludedProviderKeys
      }),
      antigravityRetrySignal: nextAntigravityRetrySignal
    };
  }
  return {
    excludedCurrentProvider: false,
    antigravityRetrySignal: nextAntigravityRetrySignal
  };
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
  stoplessMode?: StoplessLogMode;
  stoplessArmed?: boolean;
  activeInFlight: number;
  maxInFlight: number;
}): void {
  recordVirtualRouterHitRollup({
    routeName: args.routeName,
    poolId: args.poolId,
    providerKey: args.providerKey,
    model: args.model,
    sessionId: args.sessionId,
    projectPath: args.projectPath,
    reason: args.reason,
    stoplessMode: args.stoplessMode,
    stoplessArmed: args.stoplessArmed,
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

function bodyContainsReasoningStopFinalizedMarker(body: unknown): boolean {
  if (!body || typeof body !== 'object') {
    return false;
  }
  try {
    return JSON.stringify(body).includes(REASONING_STOP_FINALIZED_MARKER);
  } catch {
    return false;
  }
}

function detectStoplessTerminationWithoutFinalization(
  body: unknown,
  stoplessMode?: StoplessLogMode
): { reason: string; marker: string } | null {
  if ((stoplessMode !== 'on' && stoplessMode !== 'endless') || !isRecord(body)) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(body, '__sse_responses')) {
    const finishReason = readString(body[STREAM_LOG_FINISH_REASON_KEY])?.toLowerCase() ?? '';
    const finalized = body[REASONING_STOP_FINALIZED_FLAG_KEY] === true;
    if (!finalized && finishReason === 'stop') {
      return {
        reason: `stopless=${stoplessMode} but streamed wrapper completed with finish_reason=stop without reasoning.stop finalized marker`,
        marker: 'stream_wrapper_stopless_missing_reasoning_stop_finalization'
      };
    }
    return null;
  }
  if (bodyContainsReasoningStopFinalizedMarker(body)) {
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
    if (finishReason === 'stop' && !hasToolCalls) {
      return {
        reason: `stopless=${stoplessMode} but chat completion stopped without reasoning.stop finalized marker`,
        marker: 'chat_stopless_missing_reasoning_stop_finalization'
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
    if (!hasRequiredActionToolCalls && !hasFunctionCalls) {
      return {
        reason: `stopless=${stoplessMode} but responses output completed without reasoning.stop finalized marker`,
        marker: 'responses_stopless_missing_reasoning_stop_finalization'
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
    backoffScope?: 'provider' | 'recoverable' | 'attempt';
    decisionLabel?: string;
    stage?: 'provider.runtime_resolve' | 'provider.send';
    runtimeScopeExcludedCount?: number;
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
    const boundedNextAttempt = Math.max(args.attempt, Math.min(args.maxAttempts, args.nextAttempt));
    const suppressQwenChatCreateSessionSwitch =
      args.stage === 'provider.send'
      && args.statusCode === 404
      && args.errorCode === 'QWENCHAT_CREATE_SESSION_FAILED'
      && providerLabel.startsWith('qwenchat.');
    if (suppressQwenChatCreateSessionSwitch) {
      this.logStage('provider.retry.qwenchat_create_session_transient', args.requestId, {
        providerKey: providerLabel,
        attempt: args.attempt,
        nextAttempt: boundedNextAttempt,
        switchAction: args.switchAction,
        decisionLabel: args.decisionLabel,
        backoffScope: args.backoffScope,
        backoffMs: typeof args.backoffMs === 'number' ? Math.max(0, Math.round(args.backoffMs)) : undefined,
        reason: truncateReason(args.reason)
      });
      return;
    }
    const retryTag =
      `[provider-switch] req=${args.requestId} attempt=${args.attempt}/${args.maxAttempts} -> ` +
      `${boundedNextAttempt}/${args.maxAttempts}`;
    const details = [
      `provider=${providerLabel}`,
      `switch=${args.switchAction}`,
      ...(args.decisionLabel ? [`decision=${args.decisionLabel}`] : []),
      ...(args.backoffScope ? [`backoffScope=${args.backoffScope}`] : []),
      ...(args.stage ? [`stage=${args.stage}`] : []),
      ...(typeof args.statusCode === 'number' ? [`status=${args.statusCode}`] : []),
      ...(args.errorCode ? [`code=${args.errorCode}`] : []),
      ...(args.upstreamCode ? [`upstreamCode=${args.upstreamCode}`] : []),
      ...(typeof args.backoffMs === 'number' ? [`backoff=${Math.max(0, Math.round(args.backoffMs))}ms`] : []),
      ...(typeof args.runtimeScopeExcludedCount === 'number' && args.runtimeScopeExcludedCount > 0
        ? [`runtimeScopeExcluded=${args.runtimeScopeExcludedCount}`]
        : []),
      `reason=${JSON.stringify(truncateReason(args.reason))}`
    ];
    console.warn(`${retryTag} ${details.join(' ')}`);
  }

  async execute(input: PipelineExecutionInput): Promise<PipelineExecutionResult> {
    // Stats must remain stable across provider retries and requestId enhancements.
    const statsRequestId = input.requestId;
    const executorRequestId = input.requestId;
    const logicalRequestChainKey = retainLogicalRequestChain(deriveLogicalRequestChainKey(executorRequestId));
    let logicalRequestChainReleased = false;
    const releaseLogicalRequestChainIfNeeded = () => {
      if (logicalRequestChainReleased) {
        return;
      }
      logicalRequestChainReleased = true;
      releaseLogicalRequestChain(logicalRequestChainKey);
    };
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
        const retryPayloadSeed = prepareRequestPayloadRetrySeed(input.body);
        let attempt = 0;
        let lastError: unknown;
        let initialRoutePool: string[] | null = null;
        let antigravityRetrySignal: AntigravityRetrySignal | null = null;
        let poolCooldownWaitBudgetMs = 60 * 1000;
        let forcedRouteHint: string | undefined;
        let contextOverflowRetries = 0;
        let cumulativeExternalLatencyMs = 0;
        let cumulativeTrafficWaitMs = 0;
        let cumulativeClientInjectWaitMs = 0;

        while (attempt < maxAttempts) {
        attempt += 1;
        // Ensure each attempt starts from the base requestId so pipeline snapshots
        // don't inherit a provider-specific id from a previous attempt.
        input.requestId = providerRequestId;
        if (attempt > 1 && retryPayloadSeed.mode !== 'none') {
          const cloned = restoreRequestPayloadFromRetrySeed(retryPayloadSeed);
          if (cloned && typeof cloned === 'object') {
            input.body = cloned;
          }
        }
        const metadataForAttempt = decorateMetadataForAttempt(initialMetadata, attempt, excludedProviderKeys);
        const clientAbortSignal = getClientConnectionAbortSignal(metadataForAttempt);
        throwIfClientAbortSignalAborted(clientAbortSignal);
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
              await waitWithClientAbortSignal(cooldownWaitMs, clientAbortSignal);
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
        throwIfClientAbortSignalAborted(clientAbortSignal);
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
        if (excludedProviderKeys.has(target.providerKey)) {
          const reselectedExcludedPlan = resolveExcludedProviderReselectionPlan({
            providerKey: target.providerKey,
            routePool: routePoolForAttempt,
            excludedProviderKeys,
            lastError
          });
          this.logStage('provider.retry.excluded_target_reselected', providerRequestId, {
            providerKey: target.providerKey,
            excluded: Array.from(excludedProviderKeys),
            attempt,
            hasAlternativeCandidate: reselectedExcludedPlan.hasAlternativeCandidate
          });
          if (!reselectedExcludedPlan.keepExcludedForNextAttempt) {
            excludedProviderKeys.delete(target.providerKey);
          } else {
          if (reselectedExcludedPlan.hasAlternativeCandidate) {
            continue;
          }
          if (lastError) {
            throw lastError;
          }
          throw Object.assign(new Error(`Virtual router reselected excluded provider ${target.providerKey}`), {
            code: 'ERR_EXCLUDED_PROVIDER_RESELECTED',
            requestId: input.requestId,
            providerKey: target.providerKey
          });
          }
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

        let runtimeKey: string = typeof target.runtimeKey === 'string' ? target.runtimeKey : '';
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
          const providerFailurePlan = await resolveRequestExecutorProviderFailurePlan({
            error,
            retryError,
            requestId: providerRequestId,
            providerKey: target.providerKey,
            providerType: typeof (target as { providerType?: unknown }).providerType === 'string'
              ? String((target as { providerType?: string }).providerType)
              : undefined,
            providerProtocol: target.outboundProfile as ProviderProtocol,
            routeName: pipelineResult.routingDecision?.routeName,
            runtimeKey,
            target: target as unknown as Record<string, unknown>,
            dependencies: this.deps.getModuleDependencies(),
            attempt,
            maxAttempts,
            stage: 'provider.runtime_resolve',
            logicalRequestChainKey,
            logicalChainRetryLimitStageRequestId: providerRequestId,
            excludedProviderKeys,
            recordAttempt,
            logStage: (stage, requestId, details) => this.logStage(stage, requestId, details),
            routeHint: forcedRouteHint,
            forceExcludeCurrentProviderOnRetry: true,
            abortSignal: clientAbortSignal
          });
          lastError = error;
          const retryExecutionPlan = providerFailurePlan.retryExecutionPlan;
          if (!retryExecutionPlan.shouldRetry || !retryExecutionPlan.retrySwitchPlan || !retryExecutionPlan.backoffScope) {
            throw error;
          }
          if (!providerFailurePlan.retryTelemetryPlan) {
            throw error;
          }
          emitRequestExecutorProviderRetryTelemetry({
            requestId: input.requestId,
            retryTelemetryPlan: providerFailurePlan.retryTelemetryPlan,
            logStage: (stage, requestId, details) => this.logStage(stage, requestId, details),
            logProviderRetrySwitch: (switchArgs) => this.logProviderRetrySwitch(switchArgs)
          });
          continue;
        }
        const previousRequestId = input.requestId;
        if (providerContext.requestId !== input.requestId) {
          input.requestId = providerContext.requestId;
          try {
            await rebindResponsesConversationRequestId(previousRequestId, input.requestId);
          } catch (error) {
            logRequestExecutorNonBlockingError('responsesConversation.rebindRequestId', error, {
              previousRequestId,
              requestId: input.requestId,
              providerKey: target.providerKey,
              runtimeKey
            });
            logRequestExecutorDegraded('responsesConversation.rebindRequestId', input.requestId, {
              previousRequestId,
              providerKey: target.providerKey,
              runtimeKey
            });
          }
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
        throwIfClientAbortSignalAborted(clientAbortSignal);

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
          compatibilityProfile: target.compatibilityProfile,
          abortSignal: getClientConnectionAbortSignal(mergedMetadata)
        });
        this.logStage('provider.metadata_attach.completed', input.requestId, {
          providerKey: target.providerKey,
          runtimeKey,
          attempt
        });

        let trafficPermit: ProviderTrafficPermit | null = null;
        let trafficPolicyMaxInFlight = 0;
        let trafficActiveInFlightAtAcquire = 0;
        let providerSendStartedAtMs = 0;
        let providerSendElapsedMs = 0;
        const providerRequestedStream =
          typeof (providerPayload as { stream?: unknown } | undefined)?.stream === 'boolean'
            ? Boolean((providerPayload as { stream?: unknown }).stream)
            : undefined;
        const bypassTrafficGovernor = isServerToolFollowupRequest(metadataForAttempt);
        try {
          throwIfClientAbortSignalAborted(clientAbortSignal);
          if (bypassTrafficGovernor) {
            this.logStage('provider.traffic.acquire.bypassed', input.requestId, {
              providerKey: target.providerKey,
              runtimeKey,
              reason: 'servertool_followup',
              attempt
            });
          } else {
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
            trafficPolicyMaxInFlight = trafficAcquired.policy.concurrency.maxInFlight;
            trafficActiveInFlightAtAcquire = trafficAcquired.activeInFlight;
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
          }
          const routingDecisionRecord =
            pipelineResult.routingDecision && typeof pipelineResult.routingDecision === 'object'
              ? (pipelineResult.routingDecision as Record<string, unknown>)
              : undefined;

          providerSendStartedAtMs = Date.now();
          this.logStage('provider.send.start', input.requestId, {
            providerKey: target.providerKey,
            runtimeKey,
            protocol: providerProtocol,
            providerType: handle.providerType,
            providerFamily: handle.providerFamily,
            model: providerModel,
            providerLabel,
            providerRequestedStream,
            attempt
          });
          throwIfClientAbortSignalAborted(clientAbortSignal);

          allowSnapshotLocalDiskWrite(
            executorRequestId,
            providerRequestId,
            input.requestId,
            clientRequestId
          );
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
          const qwenChatNonstreamDeliveryHint =
            readQwenChatNonstreamDelivery(mergedMetadata)
            ?? readQwenChatNonstreamDeliveryFromBody(normalized.body);
          const converted = await this.convertProviderResponseIfNeeded({
            entryEndpoint: input.entryEndpoint,
            providerProtocol,
            providerType: handle.providerType,
            requestId: input.requestId,
            serverToolsEnabled,
            wantsStream: wantsStreamBase,
            originalRequest: resolveOriginalRequestForResponseConversion(retryPayloadSeed),
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
          const stoplessLogState = resolveStoplessLogState(mergedMetadata);
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
            errorToThrow.requestExecutorProviderErrorStage = 'provider.http';
            throw errorToThrow;
          }
          this.logStage('provider.response_status_check.completed', input.requestId, {
            providerKey: target.providerKey,
            convertedStatus,
            attempt
          });
          if (!bypassTrafficGovernor) {
            try {
              await this.trafficGovernor.observeOutcome?.({
                runtimeKey,
                providerKey: target.providerKey,
                requestId: input.requestId,
                success: true,
                statusCode: convertedStatus,
                activeInFlight: trafficActiveInFlightAtAcquire,
                configuredMaxInFlight: trafficPolicyMaxInFlight || undefined
              });
            } catch (observeError) {
              this.logStage('provider.traffic.observe_outcome.error', input.requestId, {
                providerKey: target.providerKey,
                runtimeKey,
                message:
                  observeError instanceof Error
                    ? observeError.message
                    : String(observeError ?? 'Unknown observe outcome error'),
                attempt
              });
            }
          }
          const emptyAssistantSignal = detectRetryableEmptyAssistantResponse(converted.body);
          if (emptyAssistantSignal) {
            const bodyForError = converted.body as Record<string, unknown>;
            const errorToThrow: any = new Error(
              `Upstream returned empty assistant payload: ${emptyAssistantSignal.reason}`
            );
            errorToThrow.statusCode = 502;
            errorToThrow.status = 502;
            errorToThrow.code = 'EMPTY_ASSISTANT_RESPONSE';
            errorToThrow.retryable = true;
            errorToThrow.requestExecutorProviderErrorStage = 'host.response_contract';
            errorToThrow.response = { data: bodyForError };
            this.logStage('host.response_contract.empty_assistant', input.requestId, {
              providerKey: target.providerKey,
              marker: emptyAssistantSignal.marker,
              reason: emptyAssistantSignal.reason,
              attempt
            });
            throw errorToThrow;
          }
          const stoplessTerminationSignal = detectStoplessTerminationWithoutFinalization(
            converted.body,
            stoplessLogState.mode
          );
          if (stoplessTerminationSignal) {
            const bodyForError =
              converted.body && typeof converted.body === 'object'
                ? (converted.body as Record<string, unknown>)
                : undefined;
            const errorToThrow: any = new Error(
              `Stopless contract violated: ${stoplessTerminationSignal.reason}`
            );
            errorToThrow.statusCode = 502;
            errorToThrow.status = 502;
            errorToThrow.code = 'STOPLESS_FINALIZATION_MISSING';
            errorToThrow.retryable = true;
            errorToThrow.requestExecutorProviderErrorStage = 'host.stopless_contract';
            if (bodyForError) {
              errorToThrow.response = { data: bodyForError };
            }
            this.logStage('host.stopless_finalization_missing', input.requestId, {
              providerKey: target.providerKey,
              marker: stoplessTerminationSignal.marker,
              reason: stoplessTerminationSignal.reason,
              stoplessMode: stoplessLogState.mode,
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
            stoplessMode: stoplessLogState.mode,
            stoplessArmed: stoplessLogState.armed,
            activeInFlight: trafficActiveInFlightAtAcquire,
            maxInFlight: trafficPolicyMaxInFlight
          });

          recordAttempt({ usage: aggregatedUsage, error: false });
          const metadataHubStageTop = readHubStageTop(mergedMetadata);
          const hubDecodeBreakdown = readHubDecodeBreakdown(metadataHubStageTop);
          const qwenChatSseProbeTag = resolveQwenChatProviderDecodeTag({
            pipelineMetadata: mergedMetadata,
            providerResponseBody: normalized.body,
            deliveryHint: qwenChatNonstreamDeliveryHint,
            expectNonstreamDelivery:
              !wantsStreamBase
              && typeof target.providerKey === 'string'
              && target.providerKey.startsWith('qwenchat.'),
            compatibilityProfile: target.compatibilityProfile,
            providerClassName:
              handle.instance && typeof handle.instance === 'object'
                ? (handle.instance as { constructor?: { name?: string } }).constructor?.name
                : undefined,
            providerRequestedStream
          });
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
              providerDecodeTag: qwenChatSseProbeTag,
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
          if (!bypassTrafficGovernor) {
            try {
              await this.trafficGovernor.observeOutcome?.({
                runtimeKey,
                providerKey: target.providerKey,
                requestId: input.requestId,
                success: false,
                statusCode: retryError.statusCode,
                errorCode: retryError.errorCode,
                upstreamCode: retryError.upstreamCode,
                reason: retryError.reason,
                activeInFlight: trafficActiveInFlightAtAcquire,
                configuredMaxInFlight: trafficPolicyMaxInFlight || undefined
              });
            } catch (observeError) {
              this.logStage('provider.traffic.observe_outcome.error', input.requestId, {
                providerKey: target.providerKey,
                runtimeKey,
                message:
                  observeError instanceof Error
                    ? observeError.message
                    : String(observeError ?? 'Unknown observe outcome error'),
                attempt
              });
            }
          }
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
          const status =
            typeof retryError.statusCode === 'number'
              ? retryError.statusCode
              : extractStatusCodeFromError(error);
          const nextAntigravityRetrySignal = isAntigravityProviderKey(target.providerKey)
            ? (() => {
            const signature = extractRetryErrorSignature(error);
            const consecutive: number =
              antigravityRetrySignal && antigravityRetrySignal.signature === signature
                ? antigravityRetrySignal.consecutive + 1
                : 1;
              return { signature, consecutive } satisfies AntigravityRetrySignal;
            })()
            : null;
          const isVerify = status === 403 && isGoogleAccountVerificationRequiredError(error);
          const isReauth = status === 403 && isAntigravityReauthRequired403(error);
          const promptTooLong = isPromptTooLongError(error);
          if (promptTooLong) {
            contextOverflowRetries += 1;
            if (forcedRouteHint !== 'longcontext') {
              forcedRouteHint = 'longcontext';
            }
          }
          const providerFailurePlan = await resolveRequestExecutorProviderFailurePlan({
            error,
            retryError,
            requestId: input.requestId,
            providerKey: target.providerKey,
            providerId: handle.providerId,
            providerType: handle.providerType,
            providerFamily: handle.providerFamily,
            providerProtocol,
            routeName: pipelineResult.routingDecision?.routeName,
            runtimeKey,
            target: target as unknown as Record<string, unknown>,
            dependencies: this.deps.getModuleDependencies(),
            attempt,
            maxAttempts,
            stage: 'provider.send',
            logicalRequestChainKey,
            logicalChainRetryLimitStageRequestId: input.requestId,
            routePool: routePoolForAttempt,
            runtimeManager: this.deps.runtimeManager,
            excludedProviderKeys,
            recordAttempt,
            logStage: (stage, requestId, details) => this.logStage(stage, requestId, details),
            routeHint: forcedRouteHint,
            promptTooLong,
            contextOverflowRetries,
            maxContextOverflowRetries: MAX_CONTEXT_OVERFLOW_RETRIES,
            isVerify,
            isReauth,
            allowAntigravityRecovery: true,
            antigravityRetrySignal: nextAntigravityRetrySignal,
            status,
            abortSignal: clientAbortSignal
          });
          const retryExecutionPlan = providerFailurePlan.retryExecutionPlan;
          if (!retryExecutionPlan.shouldRetry || !retryExecutionPlan.retrySwitchPlan || !retryExecutionPlan.backoffScope) {
            throw error;
          }
          antigravityRetrySignal = retryExecutionPlan.antigravityRetrySignal;
          if (!providerFailurePlan.retryTelemetryPlan) {
            throw error;
          }
          emitRequestExecutorProviderRetryTelemetry({
            requestId: input.requestId,
            retryTelemetryPlan: providerFailurePlan.retryTelemetryPlan,
            logStage: (stage, requestId, details) => this.logStage(stage, requestId, details),
            logProviderRetrySwitch: (switchArgs) => this.logProviderRetrySwitch(switchArgs)
          });
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
        releaseLogicalRequestChainIfNeeded();
      }
    } catch (error: unknown) {
      // If we failed before selecting a provider (no bindProvider/recordAttempt),
      // at least record one error sample for this request.
      if (!recordedAnyAttempt) {
        recordAttempt({ error: true });
      }
      releaseLogicalRequestChainIfNeeded();
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
  readQwenChatNonstreamDelivery,
  readQwenChatNonstreamDeliveryFromBody,
  formatQwenChatSseProbeTag,
  resolveQwenChatProviderDecodeTag,
  extractRetryErrorSnapshot,
  truncateReason,
  isHealthNeutralProviderError,
  buildRecoverableErrorBackoffKey,
  consumeRecoverableErrorBackoffMs,
  detectRetryableEmptyAssistantResponse,
  deriveLogicalRequestChainKey,
  prepareRequestPayloadRetrySeed,
  resolveOriginalRequestForResponseConversion,
  resolveRequestExecutorProviderErrorClassification,
  resolveRequestExecutorProviderErrorReportPlan,
  resolveProviderRetryEligibilityPlan,
  resolveProviderRetryExclusionPlan,
  resolveExcludedProviderReselectionPlan,
  resolveProviderRetryExecutionPlan,
  buildProviderRetryTelemetryPlan,
  resetRequestExecutorInternalStateForTests
};

export function createRequestExecutor(deps: RequestExecutorDeps): RequestExecutor {
  return new HubRequestExecutor(deps);
}
