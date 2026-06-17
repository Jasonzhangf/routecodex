import type { ServerSideToolEngineResult } from './types.js';
import { ProviderProtocolError } from '../conversion/provider-protocol-error.js';
import {
  planPendingInjectionPersistErrorWithNative,
  planPendingInjectionPersistWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import type { PendingServerToolInjection } from './pending-session.js';
import { savePendingServerToolInjection } from './pending-session.js';
import { readRuntimeMetadata } from '../conversion/runtime-metadata.js';

export const SERVERTOOL_PENDING_SESSION_FEATURE_ID = 'feature_id: hub.servertool_pending_session';

export async function persistPendingServerToolInjection(args: {
  pendingInjection: NonNullable<ServerSideToolEngineResult['pendingInjection']>;
  requestId: string;
  flowId: string;
  adapterContext?: unknown;
}): Promise<boolean> {
  const runtime = args.adapterContext && typeof args.adapterContext === 'object' && !Array.isArray(args.adapterContext)
    ? readRuntimeMetadata(args.adapterContext as Record<string, unknown>)
    : undefined;
  const sessionDir = typeof runtime?.sessionDir === 'string' && runtime.sessionDir.trim()
    ? runtime.sessionDir.trim()
    : '';
  if (!sessionDir) {
    throw new Error('[servertool-pending] runtime metadata sessionDir missing');
  }
  const plan = planPendingInjectionPersistWithNative({
    pendingInjection: args.pendingInjection,
    requestId: args.requestId,
    flowId: args.flowId,
    createdAtMs: Date.now()
  });
  if (plan.action === 'skip') {
    return false;
  }
  try {
    for (const record of plan.records) {
      await savePendingServerToolInjection(
        record.sessionId,
        record.pending as Omit<PendingServerToolInjection, 'version' | 'sessionId'>,
        sessionDir
      );
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'unknown');
    const errorPlan = planPendingInjectionPersistErrorWithNative({
      requestId: args.requestId,
      flowId: args.flowId,
      sessionIds: plan.sessionIds,
      reason: message
    });
    const wrapped = new ProviderProtocolError(errorPlan.message, {
      code: errorPlan.code as 'SERVERTOOL_PENDING_INJECTION_FAILED',
      category: errorPlan.category as 'INTERNAL_ERROR',
      details: errorPlan.details
    }) as ProviderProtocolError & { status?: number; cause?: unknown };
    wrapped.status = errorPlan.status;
    wrapped.cause = error;
    throw wrapped;
  }
}
