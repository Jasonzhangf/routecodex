import { buildServertoolProgressConfig } from './skeleton-config.js';

function normalizeFlowId(flowId: unknown): string {
  return typeof flowId === 'string' ? flowId.trim() : '';
}

export function resolveProgressToolName(flowId: unknown): string {
  const normalized = normalizeFlowId(flowId);
  if (!normalized) {
    return 'unknown';
  }
  const record = buildServertoolProgressConfig().toolNameByFlowId;
  return record[normalized] ?? normalized;
}

export function shouldUseGoldProgressHighlight(flowId: unknown): boolean {
  const normalized = normalizeFlowId(flowId);
  return normalized
    ? new Set(buildServertoolProgressConfig().goldHighlightFlowIds).has(normalized)
    : false;
}
