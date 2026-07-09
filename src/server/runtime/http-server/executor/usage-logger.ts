import { isUsageLoggingEnabled } from './env-config.js';
import type { UsageMetrics } from './usage-aggregator.js';
import { computeProtocolAwareCacheHitRatio } from './usage-aggregator.js';
import { registerRequestLogContext, resolveRequestLogColorToken } from '../../../utils/request-log-color.js';
import { formatRequestTimingSummary, isUsageTimingOutputEnabled } from '../../../utils/stage-logger.js';
import { recordUsageRollup } from './log-rollup.js';
import { recordTokens } from './token-stats-store.js';
import {
  formatProjectPort,
  formatRouteName,
  highlightLogKeyValues,
  shortRequestIdTail,
} from './log-rollup-format-blocks.js';

const ANSI_RESET = '\x1b[0m';
const ANSI_WHITE = '\x1b[97m';

const DEFAULT_HUB_STAGE_TOP_N = 5;
const USAGE_DETAIL_TIMING_MIN_MS = 100;

type HubStageTopEntry = {
  stage: string;
  totalMs: number;
  count?: number;
  avgMs?: number;
  maxMs?: number;
};

export function resolveLocalDayKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatMs(value: number): string {
  return `${Math.max(0, Math.round(value))}ms`;
}

function hiPair(key: string, value: string | number, _baseColor: string): string {
  return `${key}=${ANSI_WHITE}${value}${ANSI_RESET}${_baseColor}`;
}

function hiMsPairIfSlow(key: string, valueMs: number, baseColor: string): string {
  if (!Number.isFinite(valueMs) || valueMs < USAGE_DETAIL_TIMING_MIN_MS) {
    return '';
  }
  return hiPair(key, formatMs(valueMs), baseColor);
}

function colorizeNumericValues(text: string, _baseColor: string): string {
  return highlightLogKeyValues(text, _baseColor);
}

function readTopN(): number {
  const raw = process.env.ROUTECODEX_USAGE_HUB_TOP_N ?? process.env.RCC_USAGE_HUB_TOP_N;
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_HUB_STAGE_TOP_N;
}

function formatTimingSuffix(raw: string, baseColor: string): string {
  if (!raw) {
    return '';
  }
  const match = /^\s*timing=\{(.+)\}\s*$/.exec(raw);
  if (!match) {
    return colorizeNumericValues(raw, baseColor);
  }
  const slowParts = match[1]
    .split(/,\s*/)
    .map((part) => part.trim())
    .filter((part) => {
      const valueMatch = /=([-+]?\d+(?:\.\d+)?)ms$/.exec(part);
      return valueMatch ? Number(valueMatch[1]) >= USAGE_DETAIL_TIMING_MIN_MS : true;
    });
  if (!slowParts.length) {
    return '';
  }
  return ` timing ${colorizeNumericValues(slowParts.join(', '), baseColor)}`;
}

function formatHubStageTop(entries: HubStageTopEntry[] | undefined): string {
  if (!Array.isArray(entries) || entries.length === 0) {
    return '';
  }
  const topN = readTopN();
  const normalized = entries
    .filter((entry) => entry && typeof entry.stage === 'string' && Number.isFinite(entry.totalMs))
    .filter((entry) => entry.totalMs >= USAGE_DETAIL_TIMING_MIN_MS)
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, topN)
    .map((entry) => {
      const count =
        typeof entry.count === 'number' && Number.isFinite(entry.count) && entry.count > 0
          ? `x${Math.floor(entry.count)}`
          : '';
      return `${entry.stage}:${formatMs(entry.totalMs)}${count}`;
    });
  if (!normalized.length) {
    return '';
  }
  return ` hub.top=${normalized.join('|')}`;
}

export function logUsageSummary(
  requestId: string,
  info: {
    providerKey?: string;
    model?: string;
    requestModel?: string;
    providerProtocol?: string;
    routeName?: string;
    poolId?: string;
    entryPort?: number;
    finishReason?: string;
    usage?: UsageMetrics;
    externalLatencyMs?: number;
    trafficWaitMs?: number;
    clientInjectWaitMs?: number;
    sseDecodeMs?: number;
    codecDecodeMs?: number;
    providerDecodeTag?: string;
    providerAttemptCount?: number;
    retryCount?: number;
    hubStageTop?: HubStageTopEntry[];
    latencyMs: number;
    timingRequestIds?: string[];
    logSessionColorKey?: unknown;
    clientTmuxSessionId?: unknown;
    client_tmux_session_id?: unknown;
    tmuxSessionId?: unknown;
    tmux_session_id?: unknown;
    rccSessionClientTmuxSessionId?: unknown;
    rcc_session_client_tmux_session_id?: unknown;
    sessionId?: unknown;
    session_id?: unknown;
    conversationId?: unknown;
    conversation_id?: unknown;
    projectPath?: unknown;
    firstContentAtMs?: number;
    lastContentAtMs?: number;
    requestStartedAtMs?: number;
    providerRequestId?: string;
    inputRequestId?: string;
  },
  options?: {
    terminalTiming?: boolean;
  }
): void {
  if (!isUsageLoggingEnabled()) {
    if (options?.terminalTiming) {
      formatRequestTimingSummary(requestId, { terminal: true });
    }
    return;
  }
  const latency = info.latencyMs.toFixed(1);
  const requestLogContext = {
    logSessionColorKey: info.logSessionColorKey,
    clientTmuxSessionId: info.clientTmuxSessionId,
    client_tmux_session_id: info.client_tmux_session_id,
    tmuxSessionId: info.tmuxSessionId,
    tmux_session_id: info.tmux_session_id,
    rccSessionClientTmuxSessionId: info.rccSessionClientTmuxSessionId,
    rcc_session_client_tmux_session_id: info.rcc_session_client_tmux_session_id,
    sessionId: info.sessionId,
    session_id: info.session_id,
    conversationId: info.conversationId,
    conversation_id: info.conversation_id
  };
  const providerProtocol =
    typeof info.providerProtocol === 'string' && info.providerProtocol.trim()
      ? info.providerProtocol.trim().toLowerCase()
      : undefined;
  const logSessionColorKey =
    typeof info.logSessionColorKey === 'string' && info.logSessionColorKey.trim()
      ? info.logSessionColorKey.trim()
      : undefined;
  registerRequestLogContext(requestId, requestLogContext);
  const externalLatencyMs = Number.isFinite(info.externalLatencyMs as number)
    ? Math.max(0, Number(info.externalLatencyMs))
    : 0;
  const sseDecodeMs = Number.isFinite(info.sseDecodeMs as number)
    ? Math.max(0, Number(info.sseDecodeMs))
    : 0;
  const trafficWaitMs = Number.isFinite(info.trafficWaitMs as number)
    ? Math.max(0, Number(info.trafficWaitMs))
    : 0;
  const clientInjectWaitMs = Number.isFinite(info.clientInjectWaitMs as number)
    ? Math.max(0, Number(info.clientInjectWaitMs))
    : 0;
  const codecDecodeMs = Number.isFinite(info.codecDecodeMs as number)
    ? Math.max(0, Number(info.codecDecodeMs))
    : 0;
  const decodeResidualMs = Math.max(0, codecDecodeMs - sseDecodeMs);
  const internalLatencyMs = Math.max(
    0,
    info.latencyMs - externalLatencyMs - sseDecodeMs - trafficWaitMs - clientInjectWaitMs - decodeResidualMs
  );
  const providerAttemptCount = Number.isFinite(info.providerAttemptCount as number)
    ? Math.max(1, Math.floor(Number(info.providerAttemptCount)))
    : 1;
  const retryCount = Number.isFinite(info.retryCount as number)
    ? Math.max(0, Math.floor(Number(info.retryCount)))
    : Math.max(0, providerAttemptCount - 1);
  recordUsageRollup({
    requestId,
    routeName: info.routeName,
    poolId: info.poolId,
    providerKey: info.providerKey,
    model: info.model,
    providerProtocol,
    sessionId:
      (typeof info.sessionId === 'string' && info.sessionId.trim()
        ? info.sessionId
        : (typeof info.conversationId === 'string' ? info.conversationId : undefined)),
    projectPath: typeof info.projectPath === 'string' ? info.projectPath : undefined,
    latencyMs: info.latencyMs,
    internalLatencyMs,
    externalLatencyMs,
    trafficWaitMs,
    clientInjectWaitMs,
    sseDecodeMs,
    codecDecodeMs,
    providerDecodeTag: info.providerDecodeTag,
    providerAttemptCount,
    retryCount,
    finishReason: info.finishReason,
    promptTokens: info.usage?.prompt_tokens,
    completionTokens: info.usage?.completion_tokens,
    cacheReadTokens: info.usage?.cache_read_input_tokens,
    cacheCreationTokens: info.usage?.cache_creation_input_tokens,
    totalTokens: info.usage?.total_tokens,
    firstContentAtMs: info.firstContentAtMs,
    lastContentAtMs: info.lastContentAtMs,
    requestStartedAtMs: info.requestStartedAtMs,
    logSessionColorKey,
    suppressRealtimeSessionLog: true
  });
  // Record token consumption for persistent cumulative tracking
  {
    const pt = info.usage?.prompt_tokens ?? 0;
    const ct = info.usage?.completion_tokens ?? 0;
    const tt = info.usage?.total_tokens ?? (pt + ct);
    const cacheRead = info.usage?.cache_read_input_tokens ?? 0;
    if (pt > 0 || ct > 0 || tt > 0) {
      recordTokens(info.providerKey ?? 'unknown', info.model ?? '-', pt, ct, tt, cacheRead);
    }
  }
  const cacheRatio = computeProtocolAwareCacheHitRatio(info.usage, providerProtocol);
  const cacheValue = cacheRatio !== undefined ? `${(cacheRatio * 100).toFixed(1)}%` : '-';
  const finishReason = info.finishReason && info.finishReason.trim() ? info.finishReason.trim() : undefined;
  const usage = info.usage;
  const hasUsageMetrics = Boolean(
    usage
    && (
      Number.isFinite(usage.prompt_tokens)
      || Number.isFinite(usage.completion_tokens)
      || Number.isFinite(usage.total_tokens)
      || Number.isFinite(usage.cache_read_input_tokens)
      || Number.isFinite(usage.cache_creation_input_tokens)
    )
  );
  const inputTokens = usage?.prompt_tokens;
  const outputTokens = usage?.completion_tokens;
  const totalTokens = usage?.total_tokens;
  const cacheReadTokens = usage?.cache_read_input_tokens;
  const route = info.routeName ?? '-';
  const entryPort = typeof info.entryPort === 'number' ? info.entryPort : undefined;
  const requestModel = typeof info.requestModel === 'string' && info.requestModel.trim() ? info.requestModel.trim() : '-';
  const hitModel = info.model ?? '-';
  const project = typeof info.projectPath === 'string' && info.projectPath.trim()
    ? info.projectPath.trim()
    : undefined;
  const projectPort = formatProjectPort(project, entryPort);
  const routeLabel = formatRouteName(route);
  const shortReq = shortRequestIdTail(requestId);
  const timingSuffix = formatRequestTimingSummary(requestId, {
    latencyMs: info.latencyMs,
    requestIds: info.timingRequestIds,
    terminal: options?.terminalTiming === true
  });
  const hubStageTopSuffix = isUsageTimingOutputEnabled() ? formatHubStageTop(info.hubStageTop) : '';
  const requestColor = resolveRequestLogColorToken(requestId, requestLogContext) ?? '';
  const diagTimings = [
    hiMsPairIfSlow('wait.traffic', trafficWaitMs, requestColor),
    hiMsPairIfSlow('wait.inject', clientInjectWaitMs, requestColor),
    hiMsPairIfSlow('decode.sse', sseDecodeMs, requestColor),
    hiMsPairIfSlow('decode.codec', codecDecodeMs, requestColor)
  ].filter(Boolean).join(' ');
  const detailParts = [
    diagTimings,
    typeof info.providerDecodeTag === 'string' && info.providerDecodeTag.trim() ? info.providerDecodeTag.trim() : '',
    formatTimingSuffix(timingSuffix, requestColor),
    hubStageTopSuffix.trim()
  ].filter(Boolean);
  const cacheSummary = `${cacheReadTokens ?? 0}/${inputTokens ?? 0}(${cacheValue})`;
  const usageSummary = hasUsageMetrics
    ? `usage=in:${inputTokens ?? 0} out:${outputTokens ?? 0} cache=${cacheSummary} total=${totalTokens ?? ((inputTokens ?? 0) + (outputTokens ?? 0))}`
    : 'usage=unreported';
  const finishReasonSuffix = finishReason ? ` finish_reason=${finishReason}` : '';
  const lines = [
    `${requestColor}${colorizeNumericValues(
      `[usage] req=${shortReq} project=${projectPort} route=${routeLabel} model=${requestModel}->${hitModel} ${usageSummary} time=i:${formatMs(internalLatencyMs)} e:${formatMs(externalLatencyMs)} t:${latency}ms${finishReasonSuffix}`,
      requestColor
    )}${ANSI_RESET}`
  ];
  if (detailParts.length > 0) {
    lines.push(`${requestColor}${colorizeNumericValues(`        ${detailParts.join(' ')}`, requestColor)}${ANSI_RESET}`);
  }
  console.log(lines.join('\n'));
}
