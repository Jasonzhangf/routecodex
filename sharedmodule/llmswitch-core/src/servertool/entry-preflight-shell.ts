import type { JsonObject, ServerSideToolEngineOptions, ServerSideToolEngineResult } from './types.js';
import {
  isAdapterClientDisconnectedWithNative,
  readServertoolEntryBaseObjectWithNative,
  resolveServertoolEntryPreflightApplicationWithNative,
  resolveServertoolEntryPreflightWithNative
} from 'rcc-llmswitch-core/native/servertool-wrapper';
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
  const entryPreflightApplication = resolveServertoolEntryPreflightApplicationWithNative({
    entryPreflight: entryPreflightDecision
  });
  if (entryPreflightApplication.throwError === true) {
    throw createServertoolProviderProtocolErrorFromPlan(entryPreflightApplication.errorPlan);
  }
  if (entryPreflightApplication.returnResult === true) {
    return {
      action: 'return_result',
      result: entryPreflightApplication.result
    };
  }
  return {
    action: 'continue',
    baseObject: entryPreflightApplication.baseObject
  };
}
