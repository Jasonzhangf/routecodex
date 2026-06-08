import type { ResponsesRequestContext } from './responses-openai-bridge.js';
import { evaluateResponsesHostPolicyWithNative } from '../../native/router-hotpath/native-hub-pipeline-resp-semantics.js';

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
