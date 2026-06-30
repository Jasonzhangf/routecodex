import type { ServerSideToolEngineOptions, ServerSideToolEngineResult } from './types.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { planServertoolEntryPreflightWithNative } from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  createServerToolClientDisconnectedError,
  isAdapterClientDisconnected
} from './timeout-error-block.js';

export function runServertoolEntryPreflight(args: {
  options: ServerSideToolEngineOptions;
}):
  | { action: 'continue'; baseObject: JsonObject }
  | { action: 'return_result'; result: ServerSideToolEngineResult } {
  const base =
    args.options.chatResponse && typeof args.options.chatResponse === 'object' && !Array.isArray(args.options.chatResponse)
      ? args.options.chatResponse as JsonObject
      : null;
  const entryPreflightPlan = planServertoolEntryPreflightWithNative({
    hasBaseObject: Boolean(base),
    adapterClientDisconnected: isAdapterClientDisconnected(args.options.adapterContext)
  });
  if (entryPreflightPlan.action === 'return_passthrough_non_object_chat') {
    return {
      action: 'return_result',
      result: { mode: 'passthrough', finalChatResponse: args.options.chatResponse }
    };
  }
  if (entryPreflightPlan.action === 'throw_client_disconnected') {
    throw createServerToolClientDisconnectedError({
      requestId: args.options.requestId
    });
  }
  return {
    action: 'continue',
    baseObject: base as JsonObject
  };
}
