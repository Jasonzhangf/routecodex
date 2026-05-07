import type { JsonObject } from '../conversion/hub/types/json.js';
import type { ServerSideToolEngineResult } from './types.js';
import { ProviderProtocolError } from '../conversion/provider-protocol-error.js';
import { savePendingServerToolInjection } from './pending-session.js';

export async function persistPendingServerToolInjection(args: {
  pendingInjection: NonNullable<ServerSideToolEngineResult['pendingInjection']>;
  requestId: string;
  flowId: string;
}): Promise<boolean> {
  const sessionIds = [
    args.pendingInjection.sessionId,
    ...(Array.isArray(args.pendingInjection.aliasSessionIds)
      ? args.pendingInjection.aliasSessionIds
      : [])
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());
  const uniqueSessionIds = Array.from(new Set(sessionIds));
  if (uniqueSessionIds.length === 0) {
    return false;
  }
  try {
    for (const sessionId of uniqueSessionIds) {
      await savePendingServerToolInjection(sessionId, {
        createdAtMs: Date.now(),
        afterToolCallIds: args.pendingInjection.afterToolCallIds,
        messages: args.pendingInjection.messages,
        sourceRequestId: args.requestId
      });
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'unknown');
    const wrapped = new ProviderProtocolError('[servertool] pending injection persistence failed', {
      code: 'SERVERTOOL_PENDING_INJECTION_FAILED',
      category: 'INTERNAL_ERROR',
      details: {
        requestId: args.requestId,
        flowId: args.flowId,
        sessionIds: uniqueSessionIds,
        reason: message
      }
    }) as ProviderProtocolError & { status?: number; cause?: unknown };
    wrapped.status = 502;
    wrapped.cause = error;
    throw wrapped;
  }
}
