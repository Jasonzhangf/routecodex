import type { ServerSideToolEngineOptions, ServerSideToolEngineResult } from './types.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import {
  isAdapterClientDisconnectedWithNative,
  planServertoolClientDisconnectedErrorWithNative,
  planServertoolEntryPreflightWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  createServertoolProviderProtocolErrorFromPlan
} from './timeout-error-block.js';

export function runServertoolEntryPreflight(args: {
  options: ServerSideToolEngineOptions;
}):
  | { action: 'continue'; baseObject: JsonObject }
  | { action: 'return_result'; result: ServerSideToolEngineResult } {
  const base =
    args.options.chatResponse != null && typeof args.options.chatResponse === 'object' && !Array.isArray(args.options.chatResponse)
      ? args.options.chatResponse as JsonObject
      : null;
  const entryPreflightPlan = planServertoolEntryPreflightWithNative({
    hasBaseObject: base != null,
    adapterClientDisconnected: isAdapterClientDisconnectedWithNative(args.options.adapterContext)
  });
  switch (entryPreflightPlan.action) {
    case 'return_passthrough_non_object_chat':
      return {
        action: 'return_result',
        result: { mode: entryPreflightPlan.resultMode, finalChatResponse: args.options.chatResponse }
      };
    case 'throw_client_disconnected':
      throw createServertoolProviderProtocolErrorFromPlan(
        planServertoolClientDisconnectedErrorWithNative({
          requestId: args.options.requestId
        })
      );
    case 'continue_to_tool_flow':
      return {
        action: 'continue',
        baseObject: base as JsonObject
      };
    default:
      throw new Error('[servertool] invalid entry preflight action');
  }
}
