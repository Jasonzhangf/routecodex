import { resolveClientInjectReadyWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

export function isClientInjectReady(metadata: Record<string, unknown>): boolean {
  return resolveClientInjectReadyWithNative(metadata);
}
