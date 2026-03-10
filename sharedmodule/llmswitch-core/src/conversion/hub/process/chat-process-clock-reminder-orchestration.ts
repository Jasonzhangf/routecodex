import { logClock } from '../../../servertool/clock/log.js';
import {
  reserveDueTasksForRequest,
  scheduleClockTasks,
  type ClockConfigSnapshot,
  type ClockReservation,
  type ClockScheduleItem
} from '../../../servertool/clock/task-store.js';
import type { StandardizedMessage } from '../types/standardized.js';
import type { ClockScheduleDirective } from './chat-process-clock-directives.js';
import { buildClockMarkerScheduleMessages } from './chat-process-clock-reminder-messages.js';
import {
  buildGuardedClockScheduleItemWithNative,
  normalizeDueInjectTextWithNative,
  shouldReserveClockDueReminderWithNative
} from '../../../router/virtual-router/engine-selection/native-chat-process-clock-reminder-orchestration-semantics.js';

type ClockReminderSchedulingDeps = {
  nowFn?: () => number;
  logClockFn?: typeof logClock;
  scheduleClockTasksFn?: typeof scheduleClockTasks;
  buildClockMarkerScheduleMessagesFn?: typeof buildClockMarkerScheduleMessages;
};

type ClockReminderReservationDeps = {
  reserveDueTasksForRequestFn?: typeof reserveDueTasksForRequest;
};

export async function scheduleClockReminderDirectiveMessages(
  options: {
    clockScheduleDirectives: ClockScheduleDirective[];
    sessionId: string | null;
    requestId: string;
    clockConfig: ClockConfigSnapshot;
  },
  deps: ClockReminderSchedulingDeps = {}
): Promise<StandardizedMessage[]> {
  const nowFn = deps.nowFn ?? Date.now;
  const logClockFn = deps.logClockFn ?? logClock;
  const scheduleClockTasksFn = deps.scheduleClockTasksFn ?? scheduleClockTasks;
  const buildMessagesFn = deps.buildClockMarkerScheduleMessagesFn ?? buildClockMarkerScheduleMessages;
  let markerToolMessages: StandardizedMessage[] = [];

  for (let index = 0; index < options.clockScheduleDirectives.length; index += 1) {
    const marker = options.clockScheduleDirectives[index];
    const now = nowFn();
    const guardedItem = buildGuardedClockScheduleItemWithNative(
      marker,
      options.requestId,
      Number(options.clockConfig.dueWindowMs),
      Number(now)
    ) as ClockScheduleItem;

    if (!options.sessionId) {
      markerToolMessages = markerToolMessages.concat(
        buildMessagesFn(options.requestId, index, marker, {
          ok: false,
          action: 'schedule',
          message: 'clock requires tmux session scope (clientTmuxSessionId/tmuxSessionId).'
        })
      );
      continue;
    }

    try {
      const scheduled = await scheduleClockTasksFn(options.sessionId, [guardedItem], options.clockConfig);
      markerToolMessages = markerToolMessages.concat(
        buildMessagesFn(options.requestId, index, marker, {
          ok: true,
          action: 'schedule',
          scheduled: scheduled.map((entry) => ({
            taskId: entry.taskId,
            dueAt: new Date(entry.dueAtMs).toISOString(),
            task: entry.task,
            deliveryCount: entry.deliveryCount
          }))
        })
      );
      logClockFn('schedule', { sessionId: options.sessionId, count: scheduled.length, source: 'marker' });
    } catch (error) {
      markerToolMessages = markerToolMessages.concat(
        buildMessagesFn(options.requestId, index, marker, {
          ok: false,
          action: 'schedule',
          message: `clock.schedule failed: ${error instanceof Error ? error.message : String(error ?? 'unknown')}`
        })
      );
    }
  }

  return markerToolMessages;
}

export async function reserveClockDueReminderForRequest(
  options: {
    hadClear: boolean;
    sessionId: string | null;
    requestId: string;
    clockConfig: ClockConfigSnapshot;
  },
  deps: ClockReminderReservationDeps = {}
): Promise<{ reservation: ClockReservation | null; dueInjectText: string }> {
  const shouldReserve = shouldReserveClockDueReminderWithNative(
    options.hadClear,
    options.sessionId
  );
  if (!shouldReserve) {
    return { reservation: null, dueInjectText: '' };
  }
  const reserveDueTasksForRequestFn = deps.reserveDueTasksForRequestFn ?? reserveDueTasksForRequest;
  try {
    const reserved = await reserveDueTasksForRequestFn({
      reservationId: `${options.requestId}:clock`,
      sessionId: options.sessionId,
      config: options.clockConfig,
      requestId: options.requestId
    });
    return {
      reservation: reserved.reservation,
      dueInjectText: normalizeDueInjectTextWithNative(
        (reserved as Record<string, unknown>).injectText
      )
    };
  } catch {
    return { reservation: null, dueInjectText: '' };
  }
}
