import { isUsageLoggingEnabled } from './env-config.js';
import type { UsageMetrics } from './usage-aggregator.js';
import { computeCacheHitRatio } from './usage-aggregator.js';
import { buildProviderLabel } from './provider-response-utils.js';
import { registerRequestLogContext, resolveRequestLogColorToken } from '../../../utils/request-log-color.js';
import { formatRequestTimingSummary, isUsageTimingOutputEnabled } from '../../../utils/stage-logger.js';
import { recordUsageRollup } from './log-rollup.js';
import { recordTokens } from './token-stats-store.js';
import {
  formatProjectPort,
  formatRouteName,
  shortRequestIdTail,
} from './log-rollup-format-blocks.js';

type DailyProviderStat = {
  calls: number;
  failures: number;
  totalLatencyMs: number;
};

const ANSI_RESET = '\x1b[0m';
const ANSI_WHITE = '\x1b[97m';

type HubStageTopEntry = {
  stage: string;
  totalMs: number;
  count?: number;
  avgMs?: number;
  maxMs?: number;
};

const DEFAULT_HUB_STAGE_TOP_N = 5;
const USAGE_DETAIL_TIMING_MIN_MS = 100;

export function resolveLocalDayKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const dailyProviderStats = new Map<string, DailyProviderStat>();
let dailyProviderStatsDate = resolveLocalDayKey();

function readTopN(): number {
  const raw = process.env.ROUTECODEX_USAGE_HUB_TOP_N ?? process.env.RCC_USAGE_HUB_TOP_N;
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_HUB_STAGE_TOP_N;
}

function formatMs(value: number): string {
  return `${Math.max(0, Math.round(value))}ms`;
}

function padLabel(label: string, width = 7): string {
  return label.length >= width ? label : `${label}${' '.repeat(width - label.length)}`;
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
  if (!text) {
    return '';
  }
  return text.replace(
    /([A-Za-z][A-Za-z0-9_.]*)=([^ \x1b,)\]]+)([,\)])?/g,
    (_match, key: string, value: string, suffix = '') => {
      if (key !== 'finish_reason' && !/^[-+]?\d/.test(value)) {
        return `${key}=${value}${suffix}`;
      }
      return `${key}=${ANSI_WHITE}${value}${ANSI_RESET}${_baseColor}${suffix}`;
    }
  );
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

function updateDailyProviderStat(args: {
  providerKey?: string;
  model?: string;
  routeName?: string;
  poolId?: string;
  latencyMs: number;
  retryCount: number;
  finishReason?: string;
}): { calls: number; failures: number; avgMs: number } {
  const today = resolveLocalDayKey();
  if (dailyProviderStatsDate !== today) {
    dailyProviderStatsDate = today;
    dailyProviderStats.clear();
  }
  const key = [args.routeName || 'route', args.poolId || '-', args.providerKey || 'unknown-provider', args.model || '-'].join('\u0000');
  const row = dailyProviderStats.get(key) ?? { calls: 0, failures: 0, totalLatencyMs: 0 };
  row.calls += 1;
  row.failures += args.retryCount > 0 || args.finishReason === 'error' ? 1 : 0;
  row.totalLatencyMs += Math.max(0, args.latencyMs);
  dailyProviderStats.set(key, row);
  return {
    calls: row.calls,
    failures: row.failures,
    avgMs: row.calls > 0 ? row.totalLatencyMs / row.calls : 0
  };
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
  const providerLabel = buildProviderLabel(info.providerKey, info.model) ?? '-';
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
  const logSessionColorKey =
    typeof info.logSessionColorKey === 'string' && info.logSessionColorKey.trim()
      ? info.logSessionColorKey.trim()
      : undefined;
  registerRequestLogContext(requestId, requestLogContext);
  const timingSuffix = formatRequestTimingSummary(requestId, {
    latencyMs: info.latencyMs,
    requestIds: info.timingRequestIds,
    terminal: options?.terminalTiming === true
  });
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
  const hubStageTopSuffix = isUsageTimingOutputEnabled() ? formatHubStageTop(info.hubStageTop) : '';
  const dailyProviderStat = updateDailyProviderStat({
    providerKey: info.providerKey,
    model: info.model,
    routeName: info.routeName,
    poolId: info.poolId,
    latencyMs: info.latencyMs,
    retryCount,
    finishReason: info.finishReason
  });
  const cacheRatio = computeCacheHitRatio(info.usage);
  const cacheValue = cacheRatio !== undefined ? `${(cacheRatio * 100).toFixed(1)}%` : '-';
  const sampleId =
    (typeof info.providerRequestId === 'string' && info.providerRequestId.trim())
      ? info.providerRequestId.trim()
      : (typeof info.inputRequestId === 'string' && info.inputRequestId.trim())
        ? info.inputRequestId.trim()
        : requestId;
  const requestColor = resolveRequestLogColorToken(requestId, requestLogContext) ?? '';
  const finishReason = info.finishReason && info.finishReason.trim() ? info.finishReason.trim() : 'unknown';
  const usage = info.usage;
  const inputTokens = usage?.prompt_tokens ?? 'n/a';
  const outputTokens = usage?.completion_tokens ?? 'n/a';
  const totalTokens = usage?.total_tokens ?? 'n/a';
  const cacheReadTokens = usage?.cache_read_input_tokens ?? 'n/a';
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
  const cacheSummary = `${cacheReadTokens}/${inputTokens}(${cacheValue})`;
  const formattedTimingSuffix = formatTimingSuffix(timingSuffix, requestColor);
  const diagTimings = [
    hiMsPairIfSlow('wait.traffic', trafficWaitMs, requestColor),
    hiMsPairIfSlow('wait.inject', clientInjectWaitMs, requestColor),
    hiMsPairIfSlow('decode.sse', sseDecodeMs, requestColor),
    hiMsPairIfSlow('decode.codec', codecDecodeMs, requestColor)
  ].filter(Boolean).join(' ');
  const diagParts = [
    diagTimings,
    typeof info.providerDecodeTag === 'string' && info.providerDecodeTag.trim() ? info.providerDecodeTag.trim() : '',
    formattedTimingSuffix.trim(),
    hubStageTopSuffix.trim()
  ].filter(Boolean);
  const shouldPrintDiag = diagParts.length > 0;
  const lines = [
    `${requestColor}${colorizeNumericValues(
      `[usage] req=${shortReq} project=${projectPort} route=${routeLabel} model=${requestModel}->${hitModel} usage=in:${inputTokens} out:${outputTokens} cache=${cacheSummary} total=${totalTokens} time=i:${formatMs(internalLatencyMs)} e:${formatMs(externalLatencyMs)} t:${latency}ms finish_reason=${finishReason}`,
      requestColor
    )}${ANSI_RESET}`
  ];
  const detailParts = [
    `req=${requestId}`,
    sampleId && sampleId !== requestId ? `sample=${sampleId}` : '',
    providerAttemptCount > 1 ? `attempts=${providerAttemptCount}` : '',
    retryCount > 0 ? `retries=${retryCount}` : '',
    dailyProviderStat.calls > 1 ? `day.calls=${dailyProviderStat.calls}` : '',
    diagParts.length > 0 ? `diag=${diagParts.join(' ')}` : ''
  ].filter(Boolean);
  if (detailParts.length > 0) {
    lines.push(`${requestColor}${colorizeNumericValues(`        ${detailParts.join(' ')}`, requestColor)}${ANSI_RESET}`);
  }
  console.log(lines.join('\n'));
}
