import type { VirtualRouterWebSearchConfig } from '../../../router/virtual-router/types.js';
import type { HubOperation } from '../ops/operations.js';
import { buildWebSearchToolAppendOperationsWithNative } from '../../../router/virtual-router/engine-selection/native-chat-process-governance-semantics.js';

export function buildWebSearchToolAppendOperations(
  engines: Array<VirtualRouterWebSearchConfig['engines'][number]>
): HubOperation[] {
  return buildWebSearchToolAppendOperationsWithNative(engines) as HubOperation[];
}
