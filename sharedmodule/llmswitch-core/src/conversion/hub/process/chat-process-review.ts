import { buildReviewOperationsWithNative } from '../../../router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js';
import type { HubOperation } from '../ops/operations.js';
import { isClientInjectReady } from './client-inject-readiness.js';

export function buildReviewOperations(metadata: Record<string, unknown>): HubOperation[] {
  if (!isClientInjectReady(metadata)) {
    return [];
  }
  return buildReviewOperationsWithNative(metadata) as HubOperation[];
}
