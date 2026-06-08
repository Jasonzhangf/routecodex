import { planServertoolFollowupRuntimeWithNative } from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import type { FollowupFlowDecision } from '../native/router-hotpath/native-followup-mainline-semantics.js';
export type { FollowupFlowDecision } from '../native/router-hotpath/native-followup-mainline-semantics.js';

export function resolveFollowupFlowDecision(flowId: string | undefined): FollowupFlowDecision {
  return planServertoolFollowupRuntimeWithNative(flowId ?? '') as FollowupFlowDecision;
}
