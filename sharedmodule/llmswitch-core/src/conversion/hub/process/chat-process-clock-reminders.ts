import type { VirtualRouterClockConfig } from '../../../router/virtual-router/types.js';
import { readRuntimeMetadata } from '../../runtime-metadata.js';
import {
  clearClockSession,
  resolveClockConfig,
  startClockDaemonIfNeeded
} from '../../../servertool/clock/task-store.js';
import { logClock } from '../../../servertool/clock/log.js';
import { resolveClockSessionScope } from '../../../servertool/clock/session-scope.js';
import { applyHubOperations, type HubOperation } from '../ops/operations.js';
import type { StandardizedMessage, StandardizedRequest } from '../types/standardized.js';
import { buildClockStandardToolsOperations } from './chat-process-clock-tools.js';
import {
  reserveClockDueReminderForRequest,
  scheduleClockReminderDirectiveMessages
} from './chat-process-clock-reminder-orchestration.js';
import {
  buildClockReminderMessages,
  buildClockReminderMetadata,
  buildDueReminderUserMessage
} from './chat-process-clock-reminder-finalize.js';
import { resolveClockReminderTimeTagLine } from './chat-process-clock-reminder-time-tag.js';
import { extractClockReminderDirectives } from './chat-process-clock-reminder-directives.js';
import { applyHeartbeatDirectives } from './chat-process-heartbeat-directives.js';
import { isClientInjectReady } from './client-inject-readiness.js';
import { resolveClockReminderFlowPlanWithNative } from '../../../router/virtual-router/engine-selection/native-chat-process-clock-reminders-semantics.js';

function resolveSessionIdForClock(metadata: Record<string, unknown>, request: StandardizedRequest): string | null {
  const requestMetadata =
    request.metadata && typeof request.metadata === 'object' && !Array.isArray(request.metadata)
      ? (request.metadata as Record<string, unknown>)
      : null;
  return resolveClockSessionScope(metadata, requestMetadata);
}

export async function maybeInjectClockRemindersAndApplyDirectives(
  request: StandardizedRequest,
  metadata: Record<string, unknown>,
  requestId: string
): Promise<StandardizedRequest> {
  const requestAfterHeartbeat = await applyHeartbeatDirectives(request, metadata);
  if (!isClientInjectReady(metadata)) {
    return requestAfterHeartbeat;
  }
  const rt = readRuntimeMetadata(metadata);
  const flowPlan = resolveClockReminderFlowPlanWithNative(rt as Record<string, unknown>);
  // Do not inject reminders or apply clock directives during internal servertool followup hops.
  if (flowPlan.skipForServerToolFollowup) {
    return request;
  }
  const rawConfig = (rt as any)?.clock as VirtualRouterClockConfig | undefined;
  const clockConfig = resolveClockConfig(rawConfig);
  if (!clockConfig) {
    return request;
  }
  try {
    await startClockDaemonIfNeeded(clockConfig);
  } catch {
    // best-effort
  }

  const sessionId = resolveSessionIdForClock(metadata, requestAfterHeartbeat);
  const messages = Array.isArray(requestAfterHeartbeat.messages) ? requestAfterHeartbeat.messages : [];
  // 1) Apply <**clock:clear**> and <**clock:{...}**> marker extraction (latest user message only).
  const { hadClear, clockScheduleDirectives, baseMessages } = extractClockReminderDirectives(messages);

  if (hadClear) {
    if (sessionId) {
      try {
        await clearClockSession(sessionId);
        logClock('cleared', { sessionId });
      } catch {
        // best-effort: user directive should not crash request
      }
    }
    // Continue: still inject per-request time tag (but skip due reminders).
  }

  // 2) Apply private schedule directives: <**clock:{time,message}**>
  // Convert to actual clock scheduling and append synthetic tool_call/tool_result messages
  // so downstream model sees canonical tool semantics.
  const markerToolMessages: StandardizedMessage[] = await scheduleClockReminderDirectiveMessages({
    clockScheduleDirectives,
    sessionId,
    requestId,
    clockConfig
  });

  // 3) Inject due reminders as a user message + attach reservation for response-side commit.
  const { reservation, dueInjectText } = await reserveClockDueReminderForRequest({
    hadClear,
    sessionId,
    requestId,
    clockConfig
  });

  const dueUserMessage = buildDueReminderUserMessage(reservation, dueInjectText);

  // 4) When we have due tasks, ensure a standard tool set is present (best-effort).
  let nextRequest: StandardizedRequest = requestAfterHeartbeat;
  if (dueUserMessage) {
    const ensureToolsOps: HubOperation[] = buildClockStandardToolsOperations();
    nextRequest = applyHubOperations(nextRequest, ensureToolsOps);
  }

  // 5) Per-request time injection (user time tag or paired clock.get tool result).
  const timeTagLine = await resolveClockReminderTimeTagLine();

  const withReservationMetadata = buildClockReminderMetadata({
    nextRequest,
    metadata,
    dueUserMessage,
    reservation
  });

  // Always inject time via user-role content to keep the tag visible without adding
  // extra tool-call semantics that may distract the model.
  //
  // IMPORTANT: do not append an extra trailing user message, otherwise the Virtual Router
  // sees `latestMessageFromUser=true` and will force "thinking:user-input" even during
  // tool followups (last message role=tool), which breaks `coding/search/tools` routing.
  const timeInjectedMessages = buildClockReminderMessages({
    baseMessages,
    markerToolMessages,
    dueUserMessage,
    timeTagLine
  });

  return {
    ...nextRequest,
    messages: timeInjectedMessages,
    metadata: withReservationMetadata
  };
}
