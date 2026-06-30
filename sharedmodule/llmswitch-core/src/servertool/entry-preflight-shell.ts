import type { ServerSideToolEngineOptions, ServerSideToolEngineResult } from './types.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { planServertoolEntryPreflightWithNative } from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  createServerToolClientDisconnectedError,
  isAdapterClientDisconnected
} from './timeout-error-block.js';

export function runServertoolEntryPreflight(args: {
  options: ServerSideToolEngineOptions;
  base: JsonObject | null;
}):
  | { action: 'continue'; baseObject: JsonObject }
  | { action: 'return_result'; result: ServerSideToolEngineResult } {
  const passthroughResult = { mode: 'passthrough', finalChatResponse: args.options.chatResponse } as const;
  const entryPreflightPlan = planServertoolEntryPreflightWithNative({
    hasBaseObject: Boolean(args.base),
    adapterClientDisconnected: isAdapterClientDisconnected(args.options.adapterContext)
  });
  if (entryPreflightPlan.action === 'return_passthrough_non_object_chat') {
    return {
      action: 'return_result',
      result: passthroughResult
    };
  }
  if (entryPreflightPlan.action === 'throw_client_disconnected') {
    throw createServerToolClientDisconnectedError({
      requestId: args.options.requestId
    });
  }
  return {
    action: 'continue',
    baseObject: args.base as JsonObject
  };
}
