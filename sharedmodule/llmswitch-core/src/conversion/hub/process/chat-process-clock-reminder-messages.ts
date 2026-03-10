import type { StandardizedMessage } from '../types/standardized.js';
import type { ClockScheduleDirective } from './chat-process-clock-directives.js';
import {
  buildClockMarkerScheduleMessagesWithNative,
  findLastUserMessageIndexWithNative,
  injectTimeTagIntoMessagesWithNative
} from '../../../router/virtual-router/engine-selection/native-chat-process-clock-reminder-semantics.js';

export function buildClockMarkerScheduleMessages(
  requestId: string,
  markerIndex: number,
  marker: ClockScheduleDirective,
  payload: Record<string, unknown>
): StandardizedMessage[] {
  return buildClockMarkerScheduleMessagesWithNative(
    requestId,
    markerIndex,
    marker as unknown as Record<string, unknown>,
    payload
  ) as StandardizedMessage[];
}

export function findLastUserMessageIndex(messages: StandardizedMessage[]): number {
  return findLastUserMessageIndexWithNative(messages as unknown[]);
}

export function injectTimeTagIntoMessages(
  messages: StandardizedMessage[],
  timeTagLine: string
): StandardizedMessage[] {
  return injectTimeTagIntoMessagesWithNative(messages as unknown[], timeTagLine) as StandardizedMessage[];
}
