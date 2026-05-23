import type { VirtualRouterClockConfig } from '../../../../router/virtual-router/types.js';
import { readRuntimeMetadata } from '../../../runtime-metadata.js';
import {
  resolveClockConfig,
  startClockDaemonIfNeeded
} from '../../../../servertool/clock/task-store.js';
import { clearClockTasks } from '../../../../servertool/clock/tasks.js';
import { logClock } from '../../../../servertool/clock/log.js';
import { resolveClockSessionScope } from '../../../../servertool/clock/session-scope.js';
import { applyHubOperations, type HubOperation } from '../../ops/operations.js';
import type { StandardizedMessage, StandardizedRequest } from '../../types/standardized.js';
import { buildClockStandardToolsOperations } from '../chat-process-clock-tools.js';
import { stripClockClearDirectiveFromContent } from '../chat-process-clock-directives.js';
import {
  reserveClockDueReminderForRequest,
  scheduleClockReminderDirectiveMessages
} from '../chat-process-clock-reminder-orchestration.js';
import {
  buildClockReminderMessages,
  buildClockReminderMetadata,
  buildDueReminderUserMessage
} from '../chat-process-clock-reminder-finalize.js';
import { findLastUserMessageIndex } from '../chat-process-clock-reminder-messages.js';
import { resolveClockReminderTimeTagLine } from '../chat-process-clock-reminder-time-tag.js';
import { extractClockReminderDirectives } from '../chat-process-clock-reminder-directives.js';
import { isClientInjectReady } from '../client-inject-readiness.js';
import { resolveClockReminderFlowPlanWithNative } from '../../../../router/virtual-router/engine-selection/native-chat-process-clock-reminders-semantics.js';

function resolveSessionIdForClock(metadata: Record<string, unknown>, request: StandardizedRequest): string | null {
  const requestMetadata =
    request.metadata && typeof request.metadata === 'object' && !Array.isArray(request.metadata)
      ? (request.metadata as Record<string, unknown>)
      : null;
  return resolveClockSessionScope(metadata, requestMetadata);
}

export async function applyChatProcessClockRuntimeBridge(
  request: StandardizedRequest,
  metadata: Record<string, unknown>,
  requestId: string
): Promise<StandardizedRequest> {
  if (!isClientInjectReady(metadata)) {
    return request;
  }
  const rt = readRuntimeMetadata(metadata);
  const flowPlan = resolveClockReminderFlowPlanWithNative(rt as Record<string, unknown>);
  if (flowPlan.skipForServerToolFollowup) {
    return request;
  }
  const topLevelClock =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? ((metadata as Record<string, unknown>).clock as VirtualRouterClockConfig | undefined)
      : undefined;
  const rawConfig =
    ((rt as any)?.clock as VirtualRouterClockConfig | undefined)
    ?? topLevelClock;
  const clockConfig = resolveClockConfig(rawConfig);
  if (!clockConfig) {
    return request;
  }
  try {
    await startClockDaemonIfNeeded(clockConfig);
  } catch {
    // best-effort
  }

  const sessionId = resolveSessionIdForClock(metadata, request);
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const lastUserIndex = findLastUserMessageIndex(messages);
  const manualClear = lastUserIndex >= 0 && messages[lastUserIndex]
    ? stripClockClearDirectiveFromContent(messages[lastUserIndex].content)
    : { hadClear: false, next: undefined };
  if (manualClear.hadClear && sessionId) {
    try {
      await clearClockTasks(sessionId, clockConfig);
      logClock('cleared', { sessionId, source: 'manual_marker' });
    } catch {
      // best-effort: user directive should not crash request
    }
  }
  const extracted = extractClockReminderDirectives(messages);
  const hadClear = extracted.hadClear || manualClear.hadClear;
  const clockScheduleDirectives = extracted.clockScheduleDirectives;
  const baseMessages =
    manualClear.hadClear && !extracted.hadClear && lastUserIndex >= 0 && messages[lastUserIndex]
      ? messages.map((message, index) =>
          index === lastUserIndex
            ? {
                ...message,
                content: manualClear.next
              }
            : message
        )
      : extracted.baseMessages;

  if (hadClear) {
    if (extracted.hadClear && !manualClear.hadClear && sessionId) {
      try {
        await clearClockTasks(sessionId, clockConfig);
        logClock('cleared', { sessionId, source: 'native_extract' });
      } catch {
        // best-effort: user directive should not crash request
      }
    }
  }

  const markerToolMessages: StandardizedMessage[] = await scheduleClockReminderDirectiveMessages({
    clockScheduleDirectives,
    sessionId,
    requestId,
    clockConfig
  });

  const { reservation, dueInjectText } = await reserveClockDueReminderForRequest({
    hadClear,
    sessionId,
    requestId,
    clockConfig
  });

  const dueUserMessage = buildDueReminderUserMessage(reservation, dueInjectText);

  let nextRequest: StandardizedRequest = request;
  if (dueUserMessage) {
    const ensureToolsOps: HubOperation[] = buildClockStandardToolsOperations();
    nextRequest = applyHubOperations(nextRequest, ensureToolsOps);
  }

  const timeTagLine = flowPlan.injectPerRequestTimeTag
    ? await resolveClockReminderTimeTagLine()
    : '';

  const withReservationMetadata = buildClockReminderMetadata({
    nextRequest,
    metadata,
    dueUserMessage,
    reservation
  });

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
