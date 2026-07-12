/**
 * Provider response native bridge surface.
 *
 * Provider response conversion remains owned by Rust/NAPI. This host is the
 * narrow test seam for provider-response conversion glue; callers must not
 * mock or import the broad native facade directly.
 */

import {
  getRouterHotpathJsonBindingSync,
} from './native-exports.js';

export {
  detectRetryableEmptyAssistantResponseNative,
  hasRequestedToolsInSemanticsNative,
  isProviderNativeResumeContinuationNative,
  isRequiredToolCallTurnNative,
  isToolCallContinuationResponseNative,
  isToolResultFollowupTurnNative,
  resolveProviderResponseRequestSemanticsNative,
} from './native-exports.js';

export function getProviderResponseNativeBindingSync(): Record<string, unknown> {
  return getRouterHotpathJsonBindingSync() as unknown as Record<string, unknown>;
}
