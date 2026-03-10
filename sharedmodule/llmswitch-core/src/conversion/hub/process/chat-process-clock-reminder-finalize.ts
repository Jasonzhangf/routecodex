import type { StandardizedMessage, StandardizedRequest } from '../types/standardized.js';
import {
  buildClockReminderMessagesWithNative,
  buildClockReminderMetadataWithNative,
  buildDueReminderUserMessageWithNative
} from '../../../router/virtual-router/engine-selection/native-chat-process-clock-reminder-semantics.js';

export function buildDueReminderUserMessage(
  reservation: unknown,
  dueInjectText: string
): StandardizedMessage | null {
  return buildDueReminderUserMessageWithNative(reservation, dueInjectText) as StandardizedMessage | null;
}

export function buildClockReminderMetadata(options: {
  nextRequest: StandardizedRequest;
  metadata: Record<string, unknown>;
  dueUserMessage: StandardizedMessage | null;
  reservation: unknown;
}): StandardizedRequest['metadata'] {
  return buildClockReminderMetadataWithNative(
    options.nextRequest.metadata,
    options.metadata,
    options.dueUserMessage,
    options.reservation
  ) as StandardizedRequest['metadata'];
}

export function buildClockReminderMessages(options: {
  baseMessages: StandardizedMessage[];
  markerToolMessages: StandardizedMessage[];
  dueUserMessage: StandardizedMessage | null;
  timeTagLine: string;
}): StandardizedMessage[] {
  return buildClockReminderMessagesWithNative(
    options.baseMessages as unknown[],
    options.markerToolMessages as unknown[],
    options.dueUserMessage as unknown,
    options.timeTagLine
  ) as StandardizedMessage[];
}
