import type { ServerSideToolEngineOptions, ServerSideToolEngineResult } from './types.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import {
  isAdapterClientDisconnectedWithNative,
  planServertoolClientDisconnectedErrorWithNative,
  planServertoolEntryPreflightWithNative,
  readServertoolEntryBaseObjectWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  createServertoolProviderProtocolErrorFromPlan
} from './timeout-error-block.js';

export function runServertoolEntryPreflight(args: {
  options: ServerSideToolEngineOptions;
}):
  | { action: 'continue'; baseObject: JsonObject }
  | { action: 'return_result'; result: ServerSideToolEngineResult } {
  const base = readServertoolEntryBaseObjectWithNative(args.options.chatResponse);
  const entryPreflightPlan = planServertoolEntryPreflightWithNative({
    hasBaseObject: base != null,
    adapterClientDisconnected: isAdapterClientDisconnectedWithNative(args.options.adapterContext),
    chatResponse: args.options.chatResponse
  });
  switch (entryPreflightPlan.action) {
    case 'return_passthrough_non_object_chat':
      return {
        action: 'return_result',
        result: entryPreflightPlan.passthroughResult as ServerSideToolEngineResult
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
        baseObject: base
      };
    default:
      throw new Error('[servertool] invalid entry preflight action');
  }
}
