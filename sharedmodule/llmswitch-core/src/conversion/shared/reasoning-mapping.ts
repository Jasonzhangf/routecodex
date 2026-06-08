import { mapReasoningContentToResponsesOutputWithNative } from '../../native/router-hotpath/native-shared-conversion-semantics.js';

export interface ReasoningItem {
  type: 'reasoning';
  content: string;
}

export function mapReasoningContentToResponsesOutput(reasoningContent: any): ReasoningItem[] {
  if (typeof mapReasoningContentToResponsesOutputWithNative !== 'function') {
    throw new Error('[reasoning-mapping] native bindings unavailable');
  }
  return mapReasoningContentToResponsesOutputWithNative(reasoningContent);
}
