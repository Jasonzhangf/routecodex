import { clearPendingServerToolInjection, loadPendingServerToolInjection } from '../../../servertool/pending-session.js';
import { analyzePendingToolSync } from '../../../router/virtual-router/engine-selection/native-router-hotpath.js';
import type { StandardizedMessage, StandardizedRequest } from '../types/standardized.js';

const NON_BLOCKING_WARN_THROTTLE_MS = 60_000;
const nonBlockingWarnByStage = new Map<string, number>();

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

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function shouldLogNonBlockingStage(stage: string): boolean {
  const now = Date.now();
  const lastAt = nonBlockingWarnByStage.get(stage) ?? 0;
  if (now - lastAt < NON_BLOCKING_WARN_THROTTLE_MS) {
    return false;
  }
  nonBlockingWarnByStage.set(stage, now);
  return true;
}

function logPendingToolSyncNonBlockingError(
  stage: string,
  operation: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  if (!shouldLogNonBlockingStage(stage)) {
    return;
  }
  try {
    const suffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(
      `[pending-tool-sync] stage=${stage} operation=${operation} failed (non-blocking): ${formatUnknownError(error)}${suffix}`
    );
  } catch {
    void 0;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function resolvePendingSessionCandidates(metadata: Record<string, unknown>, request: StandardizedRequest): string[] {
  const candidates = [
    readString(metadata.sessionId),
    readString((request.metadata as any)?.sessionId),
    readString(metadata.conversationId),
    readString((request.metadata as any)?.conversationId)
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());
  return Array.from(new Set(candidates));
}

export async function maybeInjectPendingServerToolResultsAfterClientTools(
  request: StandardizedRequest,
  metadata: Record<string, unknown>,
  deps: PendingToolSyncDeps = {}
): Promise<StandardizedRequest> {
  const loadFn = deps.loadPendingServerToolInjectionFn ?? loadPendingServerToolInjection;
  const clearFn = deps.clearPendingServerToolInjectionFn ?? clearPendingServerToolInjection;
  const analyzeFn = deps.analyzePendingToolSyncFn ?? analyzePendingToolSync;

  const sessionCandidates = resolvePendingSessionCandidates(metadata, request);
  if (!sessionCandidates.length) {
    return request;
  }
  let loadedSessionId: string | null = null;
  let pending: Awaited<ReturnType<typeof loadFn>> = null;
  for (const sessionId of sessionCandidates) {
    pending = await loadFn(sessionId);
    if (pending) {
      loadedSessionId = sessionId;
      break;
    }
  }
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
    if (loadedSessionId) {
      await clearFn(loadedSessionId);
    }
  } catch (error) {
    logPendingToolSyncNonBlockingError('session_cleanup', 'clear_pending_server_tool_injection', error, {
      sessionId: loadedSessionId
    });
  }
  return { ...request, messages: nextMessages };
}
