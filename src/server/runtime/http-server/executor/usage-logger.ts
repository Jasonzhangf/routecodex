import { isUsageLoggingEnabled } from './env-config.js';
import type { UsageMetrics } from './usage-aggregator.js';
import { buildUsageLogText } from './usage-aggregator.js';
import { buildProviderLabel } from './provider-response-utils.js';
import { colorizeRequestLog, registerRequestLogContext } from '../../../utils/request-log-color.js';
import { formatRequestTimingSummary, isUsageTimingOutputEnabled } from '../../../utils/stage-logger.js';

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
    usage?: UsageMetrics;
    hubStageTop?: HubStageTopEntry[];
    latencyMs: number;
    timingRequestIds?: string[];
    sessionId?: unknown;
    conversationId?: unknown;
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
  const usageText = buildUsageLogText(info.usage);
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
  const hubStageTopSuffix = isUsageTimingOutputEnabled() ? formatHubStageTop(info.hubStageTop) : '';
  const line = `[usage] request ${requestId} provider=${providerLabel} latency=${latency}ms (${usageText})${timingSuffix}${hubStageTopSuffix}`;
  console.log(colorizeRequestLog(line, requestId, {
    sessionId: info.sessionId,
    conversationId: info.conversationId
  }));
}
