import type { ResponsesRequestContext } from './responses-openai-bridge.js';
import { evaluateResponsesHostPolicyWithNative } from '../../router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics.js';

export interface ResponsesHostPolicyResult {
  shouldStripHostManagedFields: boolean;
  targetProtocol: string;
}

export function evaluateResponsesHostPolicy(
  context?: ResponsesRequestContext,
  targetProtocol?: string
): ResponsesHostPolicyResult {
  return evaluateResponsesHostPolicyWithNative(context, targetProtocol);
}
