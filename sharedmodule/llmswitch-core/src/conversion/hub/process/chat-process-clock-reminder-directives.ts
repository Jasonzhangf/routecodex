import type { StandardizedMessage } from '../types/standardized.js';
import { type ClockScheduleDirective } from './chat-process-clock-directives.js';
import { findLastUserMessageIndex } from './chat-process-clock-reminder-messages.js';
import {
  extractClockReminderDirectivesWithNative
} from '../../../router/virtual-router/engine-selection/native-chat-process-clock-reminder-directives.js';
import type { ClockScheduleDirectiveCandidate } from '../../../router/virtual-router/engine-selection/native-chat-process-clock-directive-parser.js';
import { hydrateClockScheduleDirectiveCandidate } from './chat-process-clock-directive-parser.js';

export interface ClockReminderDirectiveExtraction {
  hadClear: boolean;
  clockScheduleDirectives: ClockScheduleDirective[];
  baseMessages: StandardizedMessage[];
}

function resolveDirectivesFromCandidates(
  candidates: ClockScheduleDirectiveCandidate[]
): { directives: ClockScheduleDirective[]; hasInvalid: boolean } {
  const directives: ClockScheduleDirective[] = [];
  let hasInvalid = false;
  for (const candidate of candidates) {
    const parsed = hydrateClockScheduleDirectiveCandidate(candidate);
    if (parsed) {
      directives.push(parsed);
    } else {
      hasInvalid = true;
    }
  }
  return { directives, hasInvalid };
}

function mergeResolvedBaseMessagesPreservingReferences(
  original: StandardizedMessage[],
  resolvedBaseMessages: StandardizedMessage[]
): StandardizedMessage[] {
  const lastUserIdx = findLastUserMessageIndex(original);
  const merged = original.slice();
  if (lastUserIdx >= 0) {
    const current = original[lastUserIdx];
    const resolved = resolvedBaseMessages[lastUserIdx];
    if (current && resolved) {
      merged[lastUserIdx] = { ...current, content: resolved.content };
    }
  }
  return merged;
}

export function extractClockReminderDirectives(
  messages: StandardizedMessage[]
): ClockReminderDirectiveExtraction {
  const resolved = extractClockReminderDirectivesWithNative(messages as unknown[]);
  const resolvedDirectives = resolveDirectivesFromCandidates(resolved.directiveCandidates);
  const hasInvalidCandidate = resolvedDirectives.hasInvalid;
  const shouldKeepOriginalMessages = hasInvalidCandidate;
  return {
    hadClear: shouldKeepOriginalMessages ? false : resolved.hadClear,
    clockScheduleDirectives: shouldKeepOriginalMessages ? [] : resolvedDirectives.directives,
    baseMessages: shouldKeepOriginalMessages
      ? messages
      : mergeResolvedBaseMessagesPreservingReferences(
          messages,
          resolved.baseMessages as StandardizedMessage[]
        )
  };
}
