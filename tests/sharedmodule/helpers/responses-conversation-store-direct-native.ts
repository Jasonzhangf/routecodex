import { getRouterHotpathJsonBindingSync } from '../../../src/modules/llmswitch/bridge/native-exports.js';

type NativeStoreEnvelope<T> =
  | { ok: true; result: T }
  | {
      ok: false;
      error?: {
        code?: string;
        message?: string;
      };
    };

function executeResponsesStoreOperation<T>(operation: string, payload: Record<string, unknown>): T {
  const binding = getRouterHotpathJsonBindingSync() as Record<string, unknown>;
  const fn = binding.executeResponsesConversationStoreOperationJson;
  if (typeof fn !== 'function') {
    throw new Error('executeResponsesConversationStoreOperationJson is not available');
  }
  const raw = (fn as (inputJson: string) => string)(JSON.stringify({
    operation,
    payload,
    persistenceFilePath: process.env.ROUTECODEX_RESPONSES_CONVERSATION_STORE
  }));
  const parsed = JSON.parse(raw) as NativeStoreEnvelope<T>;
  if (parsed.ok !== true) {
    throw new Error(parsed.error?.message ?? parsed.error?.code ?? 'Responses store operation failed');
  }
  return parsed.result;
}

export function hasResponsesConversationResponseInNativeStore(responseId?: string): boolean {
  return executeResponsesStoreOperation<boolean>('debug_has_response', { responseId });
}

export function hasResponsesConversationRequestInNativeStore(requestId?: string): boolean {
  return executeResponsesStoreOperation<boolean>('debug_has_request', { requestId });
}

export function hasResponsesConversationScopeInNativeStore(scopeKey?: string): boolean {
  return executeResponsesStoreOperation<boolean>('debug_has_scope', { scopeKey });
}
