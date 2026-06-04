import { isUsageLoggingEnabled } from './env-config.js';
import type { UsageMetrics } from './usage-aggregator.js';
import { computeCacheHitRatio } from './usage-aggregator.js';
import { buildProviderLabel } from './provider-response-utils.js';
import { registerRequestLogContext, resolveRequestLogColorToken } from '../../../utils/request-log-color.js';
import { formatRequestTimingSummary, isUsageTimingOutputEnabled } from '../../../utils/stage-logger.js';
import { recordUsageRollup } from './log-rollup.js';
import { recordTokens, getTokenTotals } from './token-stats-store.js';

type DailyProviderStat = {
  calls: number;
  failures: number;
  totalLatencyMs: number;
};

const dailyProviderStats = new Map<string, DailyProviderStat>();
let dailyProviderStatsDate = new Date().toISOString().slice(0, 10);
const ANSI_WHITE = '\x1b[97m';
const ANSI_RESET = '\x1b[0m';

type HubStageTopEntry = {
  stage: string;
  totalMs: number;
  count?: number;
  avgMs?: number;
  maxMs?: number;
};

const DEFAULT_HUB_STAGE_TOP_N = 5;

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

function hiValue(value: string | number, baseColor: string): string {
  return `${ANSI_WHITE}${value}${ANSI_RESET}${baseColor}`;
}

function hiPair(key: string, value: string | number, baseColor: string): string {
  return `${key}=${hiValue(value, baseColor)}`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${' '.repeat(width - value.length)}`;
}

function formatMemoryHealth(): string {
  const memory = process.memoryUsage();
  const heapTotal = memory.heapTotal > 0 ? memory.heapTotal : 1;
  const heapRatio = memory.heapUsed / heapTotal;
  const heapMb = Math.round(memory.heapUsed / 1024 / 1024);
  const rssMb = Math.round(memory.rss / 1024 / 1024);
  const state = heapRatio >= 0.9 ? 'high' : heapRatio >= 0.75 ? 'watch' : 'ok';
  return `${state}(heap=${heapMb}MB/${Math.round(heapRatio * 100)}% rss=${rssMb}MB)`;
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
  const today = new Date().toISOString().slice(0, 10);
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
    routeName?: string;
    poolId?: string;
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
    sessionId?: unknown;
    conversationId?: unknown;
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
  registerRequestLogContext(requestId, {
    sessionId: info.sessionId,
    conversationId: info.conversationId
  });
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
    requestStartedAtMs: info.requestStartedAtMs
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
  const cumulativeTotals = getTokenTotals();
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
  const cacheValue = cacheRatio !== undefined ? `${(cacheRatio * 100).toFixed(1)}%` : 'n/a';
  const sampleId =
    (typeof info.providerRequestId === 'string' && info.providerRequestId.trim())
      ? info.providerRequestId.trim()
      : (typeof info.inputRequestId === 'string' && info.inputRequestId.trim())
        ? info.inputRequestId.trim()
        : requestId;
  const tokenSuffix = cumulativeTotals.alltimeTokens > 0
    ? ` ${ANSI_WHITE}tokens.day=${cumulativeTotals.dailyTokens} tokens.all=${cumulativeTotals.alltimeTokens}${ANSI_RESET}`
    : '';
  const requestColor = resolveRequestLogColorToken(requestId, {
    sessionId: info.sessionId,
    conversationId: info.conversationId
  }) ?? '';
  const finishReason = info.finishReason && info.finishReason.trim() ? info.finishReason.trim() : 'unknown';
  const usage = info.usage;
  const inputTokens = usage?.prompt_tokens ?? 'n/a';
  const outputTokens = usage?.completion_tokens ?? 'n/a';
  const totalTokens = usage?.total_tokens ?? 'n/a';
  const route = info.routeName ?? '-';
  const pool = info.poolId ?? '-';
  const lines = [
    `${requestColor}[usage] ${pad(`req=${requestId}`, 56)} route=${route}/${pool} -> provider=${providerLabel}${ANSI_RESET}`,
    `${requestColor}        time ${hiPair('total', `${latency}ms`, requestColor)} ${hiPair('external', formatMs(externalLatencyMs), requestColor)} ${hiPair('internal', formatMs(internalLatencyMs), requestColor)} ${hiPair('attempts', providerAttemptCount, requestColor)} ${hiPair('retries', retryCount, requestColor)} ${hiPair('finish_reason', finishReason, requestColor)}${ANSI_RESET}`,
    `${requestColor}        tok  ${hiPair('in', inputTokens, requestColor)} ${hiPair('out', outputTokens, requestColor)} ${hiPair('total', totalTokens, requestColor)} ${hiPair('cache', cacheValue, requestColor)} ${hiPair('day.calls', dailyProviderStat.calls, requestColor)} ${hiPair('day.fail', dailyProviderStat.failures, requestColor)} ${hiPair('day.avg', formatMs(dailyProviderStat.avgMs), requestColor)}${tokenSuffix}${ANSI_RESET}`,
    `${requestColor}        diag mem=${formatMemoryHealth()} sample=${sampleId} ${hiPair('wait.traffic', formatMs(trafficWaitMs), requestColor)} ${hiPair('wait.inject', formatMs(clientInjectWaitMs), requestColor)} ${hiPair('decode.sse', formatMs(sseDecodeMs), requestColor)} ${hiPair('decode.codec', formatMs(codecDecodeMs), requestColor)}${typeof info.providerDecodeTag === 'string' && info.providerDecodeTag.trim() ? ` ${info.providerDecodeTag.trim()}` : ''}${timingSuffix}${hubStageTopSuffix}${ANSI_RESET}`
  ];
  console.log(lines.join('\n'));
}
