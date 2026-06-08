import {
  buildChatResponseFromResponsesFullWithNative
} from '../../native/router-hotpath/native-shared-conversion-semantics.js';

export function buildChatResponseFromResponses(payload: unknown): Record<string, unknown> | unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const output = buildChatResponseFromResponsesFullWithNative({
    payload: JSON.stringify(payload)
  });
  const parsed = JSON.parse(output) as { result?: string };
  if (typeof parsed.result !== 'string') {
    throw new Error('[responses-response-utils] native full conversion returned no result');
  }
  return JSON.parse(parsed.result);
}
