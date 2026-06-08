import type { BridgeActionDescriptor, BridgeActionStage } from './bridge-actions.js';
import {
  resolveBridgePolicyActionsWithNative,
  resolveBridgePolicyWithNative
} from '../native/router-hotpath/native-hub-bridge-policy-semantics.js';

type PhaseConfig = {
  inbound?: BridgeActionDescriptor[];
  outbound?: BridgeActionDescriptor[];
};

export interface BridgePolicy {
  id: string;
  protocol?: string;
  moduleType?: string;
  request?: PhaseConfig;
  response?: PhaseConfig;
}

export function resolveBridgePolicy(options: { protocol?: string; moduleType?: string } | undefined): BridgePolicy | undefined {
  const resolved = resolveBridgePolicyWithNative(options);
  if (!resolved) {
    return undefined;
  }
  return resolved as BridgePolicy;
}

export function resolvePolicyActions(policy: BridgePolicy | undefined, stage: BridgeActionStage): BridgeActionDescriptor[] | undefined {
  return resolveBridgePolicyActionsWithNative(policy, stage) as BridgeActionDescriptor[] | undefined;
}
