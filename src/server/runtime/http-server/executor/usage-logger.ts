import { isUsageLoggingEnabled } from './env-config.js';
import type { UsageMetrics } from './usage-aggregator.js';
import { buildUsageLogText } from './usage-aggregator.js';
import { buildProviderLabel } from './provider-response-utils.js';
import { colorizeRequestLog, registerRequestLogContext } from '../../../utils/request-log-color.js';
import { formatRequestTimingSummary } from '../../../utils/stage-logger.js';

export function logUsageSummary(
  requestId: string,
  info: {
    providerKey?: string;
    model?: string;
    usage?: UsageMetrics;
    latencyMs: number;
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
    terminal: options?.terminalTiming === true
  });
  const line = `[usage] request ${requestId} provider=${providerLabel} latency=${latency}ms (${usageText})${timingSuffix}`;
  console.log(colorizeRequestLog(line, requestId, {
    sessionId: info.sessionId,
    conversationId: info.conversationId
  }));
}
