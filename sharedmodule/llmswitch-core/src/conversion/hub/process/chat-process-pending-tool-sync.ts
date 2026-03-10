import { clearPendingServerToolInjection, loadPendingServerToolInjection } from '../../../servertool/pending-session.js';
import { analyzePendingToolSync } from '../../../router/virtual-router/engine-selection/native-router-hotpath.js';
import type { StandardizedMessage, StandardizedRequest } from '../types/standardized.js';

type PendingToolSyncDeps = {
  loadPendingServerToolInjectionFn?: (sessionId: string) => Promise<{
    afterToolCallIds?: unknown;
    messages?: unknown;
  } | null>;
  clearPendingServerToolInjectionFn?: (sessionId: string) => Promise<void>;
  analyzePendingToolSyncFn?: (
    messages: StandardizedMessage[],
    afterToolCallIds: string[]
  ) => { ready: boolean; insertAt: number };
};

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function resolveSessionIdForPending(metadata: Record<string, unknown>, request: StandardizedRequest): string | null {
  const candidate = readString(metadata.sessionId) ?? readString((request.metadata as any)?.sessionId);
  return candidate && candidate.trim() ? candidate.trim() : null;
}

export async function maybeInjectPendingServerToolResultsAfterClientTools(
  request: StandardizedRequest,
  metadata: Record<string, unknown>,
  deps: PendingToolSyncDeps = {}
): Promise<StandardizedRequest> {
  const loadFn = deps.loadPendingServerToolInjectionFn ?? loadPendingServerToolInjection;
  const clearFn = deps.clearPendingServerToolInjectionFn ?? clearPendingServerToolInjection;
  const analyzeFn = deps.analyzePendingToolSyncFn ?? analyzePendingToolSync;

  const sessionId = resolveSessionIdForPending(metadata, request);
  if (!sessionId) {
    return request;
  }
  const pending = await loadFn(sessionId);
  if (!pending) {
    return request;
  }
  const afterIds = Array.isArray(pending.afterToolCallIds)
    ? pending.afterToolCallIds
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
    : [];
  if (!afterIds.length) {
    return request;
  }

  const messages = Array.isArray(request.messages) ? request.messages : [];
  const analysis = analyzeFn(messages, afterIds);
  if (!analysis.ready) {
    return request;
  }
  if (analysis.insertAt < 0) {
    return request;
  }

  const inject = Array.isArray(pending.messages) ? (pending.messages as unknown as StandardizedMessage[]) : [];
  if (!inject.length) {
    return request;
  }

  const nextMessages = messages.slice();
  nextMessages.splice(analysis.insertAt + 1, 0, ...inject);
  try {
    await clearFn(sessionId);
  } catch {
    // best-effort
  }
  return { ...request, messages: nextMessages };
}
