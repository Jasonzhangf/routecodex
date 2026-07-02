import type { ServerSideToolEngineOptions, ServerSideToolEngineResult } from './types.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import {
  isAdapterClientDisconnectedWithNative,
  readServertoolEntryBaseObjectWithNative,
  resolveServertoolEntryPreflightWithNative
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
  const entryPreflightDecision = resolveServertoolEntryPreflightWithNative({
    requestId: args.options.requestId,
    baseObject: base,
    adapterClientDisconnected: isAdapterClientDisconnectedWithNative(args.options.adapterContext),
    chatResponse: args.options.chatResponse
  });
  if (entryPreflightDecision.action === 'throw_error') {
    throw createServertoolProviderProtocolErrorFromPlan(entryPreflightDecision.errorPlan);
  }
  return entryPreflightDecision;
}
