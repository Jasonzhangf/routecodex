import type { VirtualRouterWebSearchConfig } from '../../../router/virtual-router/types.js';
import { readRuntimeMetadata } from '../../runtime-metadata.js';
import type { HubOperation } from '../ops/operations.js';
import type { StandardizedRequest } from '../types/standardized.js';
import { buildWebSearchToolAppendOperations } from './chat-process-web-search-tool-schema.js';
import { planChatWebSearchOperationsWithNative } from '../../../router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js';

type WebSearchOperationPlan = {
  shouldInject: boolean;
  selectedEngineIndexes: number[];
};

export function buildWebSearchOperations(
  request: StandardizedRequest,
  metadata: Record<string, unknown>,
  precomputedPlan?: WebSearchOperationPlan
): HubOperation[] {
  const rt = (readRuntimeMetadata(metadata) ?? {}) as Record<string, unknown>;
  const rawConfig = (rt as any)?.webSearch as VirtualRouterWebSearchConfig | undefined;
  if (!rawConfig || !Array.isArray(rawConfig.engines) || rawConfig.engines.length === 0) {
    return [];
  }

  const plan =
    precomputedPlan ??
    planChatWebSearchOperationsWithNative(request, rt as Record<string, unknown>);
  if (!plan.shouldInject || !plan.selectedEngineIndexes.length) {
    return [];
  }

  const selectedEngines = selectEnginesByIndexes(rawConfig.engines, plan.selectedEngineIndexes);
  if (!selectedEngines.length) {
    return [];
  }
  return buildWebSearchToolAppendOperations(selectedEngines);
}

function selectEnginesByIndexes(
  engines: Array<VirtualRouterWebSearchConfig['engines'][number]>,
  indexes: number[]
): Array<VirtualRouterWebSearchConfig['engines'][number]> {
  return indexes
    .map((value) => (typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : -1))
    .filter((value) => value >= 0 && value < engines.length)
    .map((value) => engines[value]);
}
