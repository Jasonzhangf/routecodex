import type { ProcessedRequest, StandardizedMessage, StandardizedRequest } from '../../types/standardized.js';
import type { ClockConfigSnapshot, ClockReservation } from '../../../../servertool/clock/types.js';
import { readRuntimeMetadata } from '../../../runtime-metadata.js';
import {
  normalizeClockConfig,
  reserveDueTasksForRequest,
  scheduleClockTasks,
  startClockDaemonIfNeeded,
  clearClockTasks,
} from '../../../../servertool/clock/task-store.js';
import { getClockTimeSnapshot, buildTimeTagLine } from '../../../../servertool/clock/ntp.js';
import { buildClockMarkerScheduleMessages } from '../chat-process-clock-reminder-messages.js';
import { buildClockReminderMessages, buildClockReminderMetadata, buildDueReminderUserMessage } from '../chat-process-clock-reminder-finalize.js';
import { buildClockStandardToolAppendOperations } from '../chat-process-clock-tool-schemas.js';
import { applyHubOperations } from '../../ops/operations.js';
import {
  buildGuardedClockScheduleItemWithNative,
  type NativeGuardedClockScheduleItem,
} from '../../../../router/virtual-router/engine-selection/native-chat-process-clock-reminder-orchestration-semantics.js';
import { isRecord } from '../../../../shared/common-utils.js';

type ClockRuntimeMarkerDirective = {
  dueAt: string;
  dueAtMs: number;
  task: string;
  recurrence?: unknown;
};

type ClockRuntimeSummary = {
  enabled: boolean;
  config?: Record<string, unknown>;
  sessionId?: string;
  shouldClearTasks?: boolean;
  shouldScheduleMarkers?: boolean;
  shouldReserveDueReminders?: boolean;
  injectPerRequestTimeTag?: boolean;
  markerDirectives?: ClockRuntimeMarkerDirective[];
};

function readClockRuntimeSummary(processedRequest: ProcessedRequest): ClockRuntimeSummary | null {
  const processingMetadata = processedRequest.processingMetadata as Record<string, unknown> | undefined;
  const clockRuntime = processingMetadata?.clockRuntime;
  return isRecord(clockRuntime) ? (clockRuntime as ClockRuntimeSummary) : null;
}

function toClockConfig(summary: ClockRuntimeSummary): ClockConfigSnapshot | null {
  const config = isRecord(summary.config) ? summary.config : null;
  return normalizeClockConfig(config ?? { enabled: summary.enabled === true });
}

function toClockScheduleItems(markers: ClockRuntimeMarkerDirective[], requestId: string, dueWindowMs: number) {
  const nowMs = Date.now();
  return markers
    .filter((marker) => typeof marker?.task === 'string' && Number.isFinite(Number(marker?.dueAtMs)))
    .map((marker) => buildGuardedClockScheduleItemWithNative(marker as unknown as Record<string, unknown>, requestId, dueWindowMs, nowMs))
    .filter((item): item is NativeGuardedClockScheduleItem => Number.isFinite(item?.dueAtMs));
}

function readReservationMetadata(processedRequest: ProcessedRequest): ClockReservation | null {
  const metadata = processedRequest.metadata as Record<string, unknown> | undefined;
  const reservation = metadata?.__clockReservation;
  if (!isRecord(reservation)) {
    return null;
  }
  const sessionId = typeof reservation.sessionId === 'string' ? reservation.sessionId : '';
  const reservationId = typeof reservation.reservationId === 'string' ? reservation.reservationId : '';
  const taskIds = Array.isArray(reservation.taskIds) ? reservation.taskIds.filter((v): v is string => typeof v === 'string') : [];
  const reservedAtMs = Number((reservation as Record<string, unknown>).reservedAtMs);
  if (!sessionId || !reservationId || !Number.isFinite(reservedAtMs)) {
    return null;
  }
  return {
    reservationId,
    sessionId,
    taskIds,
    reservedAtMs: Math.floor(reservedAtMs),
  };
}

function hasClockReminderUserMessage(messages: StandardizedMessage[]): boolean {
  return messages.some((message) =>
    message?.role === 'user'
    && typeof message?.content === 'string'
    && message.content.includes('[Clock Reminder]')
  );
}

function injectTimeTagIfNeeded(messages: StandardizedMessage[]): Promise<StandardizedMessage[]> | StandardizedMessage[] {
  return (async () => {
    if (!messages.length) {
      return messages;
    }
    try {
      const snapshot = await getClockTimeSnapshot();
      const line = snapshot ? buildTimeTagLine(snapshot) : '';
      if (!line) {
        return messages;
      }
      const cloned = messages.slice();
      const lastUserIndex = [...cloned.keys()].reverse().find((index) => cloned[index]?.role === 'user');
      if (lastUserIndex === undefined) {
        cloned.push({ role: 'user', content: line });
        return cloned;
      }
      const target = cloned[lastUserIndex];
      if (typeof target.content === 'string') {
        cloned[lastUserIndex] = {
          ...target,
          content: target.content.trimEnd() ? `${target.content.trimEnd()}\n${line}` : line,
        };
        return cloned;
      }
      cloned[lastUserIndex] = { ...target, content: line };
      return cloned;
    } catch {
      return messages;
    }
  })();
}

export async function applyClockRuntimeSideEffectsFromProcessedRequest(
  processedRequest: ProcessedRequest,
  metadata: Record<string, unknown>,
  requestId: string,
): Promise<ProcessedRequest> {
  const summary = readClockRuntimeSummary(processedRequest);
  if (!summary?.enabled) {
    return processedRequest;
  }

  const rt = (readRuntimeMetadata(metadata) ?? {}) as Record<string, unknown>;
  const config = toClockConfig(summary);
  if (!config) {
    return processedRequest;
  }

  try {
    await startClockDaemonIfNeeded(config);
  } catch {
    // fail-fast is for semantics; daemon start remains runtime best-effort
  }

  const sessionId = typeof summary.sessionId === 'string' && summary.sessionId.trim()
    ? summary.sessionId.trim()
    : '';

  if (summary.shouldClearTasks && sessionId) {
    await clearClockTasks(sessionId, config);
  }

  const markers = Array.isArray(summary.markerDirectives) ? summary.markerDirectives : [];
  let markerToolMessages: StandardizedMessage[] = [];

  if (summary.shouldScheduleMarkers) {
    if (!sessionId) {
      markerToolMessages = markers.flatMap((marker, index) =>
        buildClockMarkerScheduleMessages(requestId, index, marker as unknown as any, {
          ok: false,
          action: 'schedule',
          message: 'clock requires tmux session scope (clientTmuxSessionId/tmuxSessionId).',
        }),
      );
    } else {
      const items = toClockScheduleItems(markers, requestId, Number(summary.config?.dueWindowMs ?? 0));
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const marker = markers[index];
        try {
          const scheduled = await scheduleClockTasks(sessionId, [item] as any, config);
          markerToolMessages = markerToolMessages.concat(
            buildClockMarkerScheduleMessages(requestId, index, marker as unknown as any, {
              ok: true,
              action: 'schedule',
              scheduled: scheduled.map((entry) => ({
                taskId: entry.taskId,
                dueAt: new Date(entry.dueAtMs).toISOString(),
                task: entry.task,
                deliveryCount: entry.deliveryCount,
              })),
            }),
          );
        } catch (error) {
          markerToolMessages = markerToolMessages.concat(
            buildClockMarkerScheduleMessages(requestId, index, marker as unknown as any, {
              ok: false,
              action: 'schedule',
              message: `clock.schedule failed: ${error instanceof Error ? error.message : String(error ?? 'unknown')}`,
            }),
          );
        }
      }
    }
  }

  let nextProcessed = processedRequest;
  const reservationFromMetadata = readReservationMetadata(processedRequest);
  if (summary.shouldReserveDueReminders && sessionId && !reservationFromMetadata && !hasClockReminderUserMessage(processedRequest.messages)) {
    const reserved = await reserveDueTasksForRequest({
      reservationId: `${requestId}:clock`,
      sessionId,
      config,
      requestId,
    });
    const injectText = typeof reserved.injectText === 'string' ? reserved.injectText : '';
    if (reserved.reservation && injectText) {
      const dueUserMessage = buildDueReminderUserMessage(reserved.reservation, injectText);
      const requestWithStandardTools = applyHubOperations(
        nextProcessed as unknown as StandardizedRequest,
        buildClockStandardToolAppendOperations(),
      ) as unknown as ProcessedRequest;
      nextProcessed = {
        ...requestWithStandardTools,
        metadata: buildClockReminderMetadata({
          nextRequest: requestWithStandardTools as unknown as StandardizedRequest,
          metadata,
          dueUserMessage,
          reservation: reserved.reservation,
        }),
      };
      nextProcessed = {
        ...nextProcessed,
        messages: buildClockReminderMessages({
          baseMessages: nextProcessed.messages,
          markerToolMessages,
          dueUserMessage,
          timeTagLine: '',
        }),
      };
    }
  }

  if (!readReservationMetadata(nextProcessed) && markerToolMessages.length > 0) {
    nextProcessed = {
      ...nextProcessed,
      messages: buildClockReminderMessages({
        baseMessages: nextProcessed.messages,
        markerToolMessages,
        dueUserMessage: null,
        timeTagLine: '',
      }),
    };
  }

  if (summary.injectPerRequestTimeTag) {
    const timeTaggedMessages = await injectTimeTagIfNeeded(nextProcessed.messages);
    nextProcessed = {
      ...nextProcessed,
      messages: timeTaggedMessages,
    };
  }

  const _ = rt;
  return nextProcessed;
}
