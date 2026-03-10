import type { JsonObject } from '../../conversion/hub/types/json.js';
import type { ServerToolHandler, ServerToolHandlerContext, ServerToolHandlerPlan } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { extractCapturedChatSeed } from './followup-request-builder.js';
import { readRuntimeMetadata } from '../../conversion/runtime-metadata.js';
import {
  findNextUndeliveredDueAtMs,
  listClockTasks,
  reserveDueTasksForRequest,
  resolveClockConfig,
  startClockDaemonIfNeeded
} from '../clock/task-store.js';
import { nowMs } from '../clock/state.js';
import { logClock } from '../clock/log.js';
import { resolveClockSessionScope } from '../clock/session-scope.js';
import { isStopEligibleForServerTool } from '../stop-gateway-context.js';

const FLOW_ID = 'clock_hold_flow';

type ClientConnectionState = { disconnected: boolean };

function resolveClientConnectionState(value: unknown): ClientConnectionState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as { disconnected?: unknown };
  if (typeof record.disconnected !== 'boolean') {
    return null;
  }
  return { disconnected: record.disconnected };
}

function clientWantsStreaming(adapterContext: unknown): boolean {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return false;
  }
  const record = adapterContext as Record<string, unknown>;
  if (
    record.stream === true ||
    record.inboundStream === true ||
    record.outboundStream === true ||
    record.clientStream === true
  ) {
    return true;
  }
  const streamingHint = typeof record.streamingHint === 'string' ? record.streamingHint.trim().toLowerCase() : '';
  if (streamingHint === 'force') {
    return true;
  }
  const clientHeaders = record.clientHeaders;
  if (clientHeaders && typeof clientHeaders === 'object' && !Array.isArray(clientHeaders)) {
    const accept = (clientHeaders as Record<string, unknown>).accept;
    if (typeof accept === 'string' && accept.toLowerCase().includes('text/event-stream')) {
      return true;
    }
  }
  return false;
}

function computeHoldSleepMs(remainingMs: number): number {
  if (remainingMs <= 0) return 0;
  if (remainingMs > 10 * 60_000) return 30_000;
  if (remainingMs > 60_000) return 10_000;
  if (remainingMs > 10_000) return 1_000;
  return 200;
}

async function sleep(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

const handler: ServerToolHandler = async (ctx: ServerToolHandlerContext): Promise<ServerToolHandlerPlan | null> => {
  const record = ctx.adapterContext as unknown as {
    serverToolFollowup?: unknown;
    clientDisconnected?: unknown;
    clientConnectionState?: unknown;
    sessionId?: unknown;
    clock?: unknown;
    capturedChatRequest?: unknown;
  };

  // Only trigger on stop/length completion (no tool calls).
  if (!isStopEligibleForServerTool(ctx.base, ctx.adapterContext)) {
    return null;
  }

  // When client already disconnected, skip holding.
  const connectionState = resolveClientConnectionState(record.clientConnectionState);
  if (connectionState?.disconnected === true) {
    return null;
  }
  const clientDisconnectedRaw = record.clientDisconnected;
  if (
    clientDisconnectedRaw === true ||
    (typeof clientDisconnectedRaw === 'string' && clientDisconnectedRaw.trim().toLowerCase() === 'true')
  ) {
    return null;
  }

  const rt = readRuntimeMetadata(ctx.adapterContext as unknown as Record<string, unknown>);
  const sessionId = resolveClockSessionScope(
    ctx.adapterContext as unknown as Record<string, unknown>,
    rt as unknown as Record<string, unknown>
  );
  if (!sessionId) {
    return null;
  }
  // Default-enable clock when config is absent, but keep "explicitly disabled" honored.
  const clockConfig = resolveClockConfig((rt as any)?.clock);
  if (!clockConfig) {
    return null;
  }
  await startClockDaemonIfNeeded(clockConfig);

  // IMPORTANT: clock hold requires a long-lived client connection.
  // - Streaming/SSE clients: ok to hold (keepalive is handled by host SSE bridge).
  // - Non-streaming/JSON clients: only hold when explicitly enabled via config,
  //   and only within a small max window (holdMaxMs).
  const wantsStream = clientWantsStreaming(ctx.adapterContext);
  if (!wantsStream && clockConfig.holdNonStreaming !== true) {
    return null;
  }

  const seed = extractCapturedChatSeed(record.capturedChatRequest);
  if (!seed) {
    return null;
  }

  const tasks = await listClockTasks(sessionId, clockConfig);
  const at = nowMs();
  const nextDueAtMs = findNextUndeliveredDueAtMs(tasks, at);
  if (!nextDueAtMs) {
    return null;
  }

  // Wait until the "due window" is reached (now >= dueAt - dueWindowMs).
  const thresholdMs = nextDueAtMs - clockConfig.dueWindowMs;
  const inDueWindow = at >= thresholdMs;
  if (inDueWindow) {
    try {
      const probe = await reserveDueTasksForRequest({
        reservationId: `${ctx.requestId}:clock_auto_probe`,
        sessionId,
        config: clockConfig,
        requestId: ctx.requestId
      });
      if (!probe.reservation || !Array.isArray(probe.reservation.taskIds) || probe.reservation.taskIds.length === 0) {
        return null;
      }
    } catch {
      return null;
    }
  } else {
    const remainingMs = thresholdMs - at;
    if (clockConfig.holdMaxMs >= 0 && remainingMs > clockConfig.holdMaxMs) {
      return null;
    }
    logClock('hold_start', { sessionId, nextDueAtMs, thresholdMs });
    while (nowMs() < thresholdMs) {
      const state = resolveClientConnectionState((ctx.adapterContext as any).clientConnectionState);
      if (state?.disconnected === true) {
        return null;
      }
      const remaining = thresholdMs - nowMs();
      await sleep(computeHoldSleepMs(remaining));
      // Best-effort: if tasks were cleared/cancelled while holding, stop holding.
      try {
        const refreshed = await listClockTasks(sessionId, clockConfig);
        const refreshedNext = findNextUndeliveredDueAtMs(refreshed, nowMs());
        if (!refreshedNext) {
          return null;
        }
      } catch {
        // ignore refresh errors; keep holding
      }
    }
  }

  return {
    flowId: FLOW_ID,
    finalize: async () => ({
      chatResponse: ctx.base,
      execution: {
        flowId: FLOW_ID,
        followup: {
          requestIdSuffix: ':clock_hold_followup',
          entryEndpoint: ctx.entryEndpoint,
          injection: {
            ops: [
              { op: 'append_assistant_message', required: false },
              { op: 'append_user_text', text: 'continue' }
            ]
          },
          metadata: {
            ...(connectionState ? { clientConnectionState: connectionState as unknown as JsonObject } : {}),
            __rt: {
              clockFollowupInjectReminders: true
            }
          } as JsonObject
        }
      }
    })
  };
};

registerServerToolHandler('clock_auto', handler, { trigger: 'auto', hook: { phase: 'post', priority: 50 } });
