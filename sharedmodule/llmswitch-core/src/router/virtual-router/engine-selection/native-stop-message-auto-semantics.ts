// Native bridge for stop-message-core decision engine.
// Decides whether stop_message_auto should trigger a followup.

import { failNativeRequired } from './native-router-hotpath-policy.js';
import { readNativeFunction } from './native-shared-conversion-semantics-core.js';
import type { StopMessageDecisionContext, StopMessageDecision } from './native-stop-message-auto-semantics.js';

function fallbackSkip(reason: string): StopMessageDecision {
  return { action: 'skip', skip_reason: reason, used: 0, max_repeats: 0 };
}

export function decideStopMessageActionWithNative(ctx: StopMessageDecisionContext): StopMessageDecision {
  const capability = 'decideStopMessageAction';
  const fn = readNativeFunction(capability);
  if (!fn) {
    // Native binding not loaded (e.g., tests). Fall back to conservative skip.
    return fallbackSkip('native_unavailable');
  }
  const inputJson = JSON.stringify(ctx);
  const resultJson = fn(inputJson);
  if (typeof resultJson !== 'string') {
    return fallbackSkip(`native_returned_non_string: ${typeof resultJson}`);
  }
  try {
    return JSON.parse(resultJson) as StopMessageDecision;
  } catch {
    return fallbackSkip('native_parse_failed');
  }
}
