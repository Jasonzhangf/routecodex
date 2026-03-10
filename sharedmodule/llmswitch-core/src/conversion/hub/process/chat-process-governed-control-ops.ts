import type { StandardizedRequest } from '../types/standardized.js';
import { applyGovernedControlOperationsWithNative } from '../../../router/virtual-router/engine-selection/native-chat-process-governance-semantics.js';

interface GovernedControlOpsOptions {
  request: StandardizedRequest;
  governed: Record<string, unknown>;
  inboundStreamIntent: boolean;
}

export function applyGovernedControlOperations(options: GovernedControlOpsOptions): StandardizedRequest {
  const { request, governed, inboundStreamIntent } = options;
  return applyGovernedControlOperationsWithNative(
    request as unknown as Record<string, unknown>,
    governed,
    inboundStreamIntent
  ) as unknown as StandardizedRequest;
}
