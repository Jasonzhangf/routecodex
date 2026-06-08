import { planServertoolFollowupRuntimeWithNative } from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import type { FollowupFlowDecision } from '../native/router-hotpath/native-followup-mainline-semantics.js';
export type { FollowupFlowDecision } from '../native/router-hotpath/native-followup-mainline-semantics.js';

function normalizeFlowId(flowId: unknown): string {
  return typeof flowId === 'string' ? flowId.trim() : '';
}

export function resolveFollowupFlowDecision(flowId: unknown): FollowupFlowDecision {
  return planServertoolFollowupRuntimeWithNative(normalizeFlowId(flowId)) as FollowupFlowDecision;
}
