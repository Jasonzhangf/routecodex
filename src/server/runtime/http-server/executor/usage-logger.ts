import { isUsageLoggingEnabled } from './env-config.js';
import type { UsageMetrics } from './usage-aggregator.js';
import { buildUsageLogText } from './usage-aggregator.js';
import { buildProviderLabel } from './provider-response-utils.js';

export function logUsageSummary(
  requestId: string,
  info: { providerKey?: string; model?: string; usage?: UsageMetrics; latencyMs: number }
): void {
  if (!isUsageLoggingEnabled()) {
    return;
  }
  const providerLabel = buildProviderLabel(info.providerKey, info.model) ?? '-';
  const usageText = buildUsageLogText(info.usage);
  const latency = info.latencyMs.toFixed(1);
  console.log(`[usage] request ${requestId} provider=${providerLabel} latency=${latency}ms (${usageText})`);
}
