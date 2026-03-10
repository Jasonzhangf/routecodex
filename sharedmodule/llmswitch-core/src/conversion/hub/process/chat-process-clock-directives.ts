import type { StandardizedMessage } from '../types/standardized.js';
import type { ClockTaskRecurrence } from '../../../servertool/clock/task-store.js';
import { stripClockClearDirectiveText } from '../../../router/virtual-router/engine-selection/native-router-hotpath.js';
import {
  extractClockScheduleDirectiveTextPartsWithNative
} from '../../../router/virtual-router/engine-selection/native-chat-process-clock-directive-parser.js';
import {
  hydrateClockScheduleDirectiveCandidate
} from './chat-process-clock-directive-parser.js';

export type ClockScheduleDirective = {
  dueAtMs: number;
  dueAt: string;
  task: string;
  recurrence?: ClockTaskRecurrence;
};

export function stripClockClearDirectiveFromText(text: string): { hadClear: boolean; next: string } {
  const analysis = stripClockClearDirectiveText(String(text || ''));
  return {
    hadClear: analysis.hadClear,
    next: analysis.next
  };
}

export function extractClockScheduleDirectivesFromText(
  text: string
): { directives: ClockScheduleDirective[]; next: string } {
  const raw = String(text || '');
  const parts = extractClockScheduleDirectiveTextPartsWithNative(raw);
  const directives: ClockScheduleDirective[] = [];
  const nextParts: string[] = [];

  for (const part of parts) {
    if (part.kind === 'text') {
      nextParts.push(part.text);
      continue;
    }
    const parsed = part.candidate ? hydrateClockScheduleDirectiveCandidate(part.candidate) : null;
    if (!parsed) {
      nextParts.push(part.full);
      continue;
    }
    directives.push(parsed);
  }

  return {
    directives,
    next: nextParts.join('').replace(/\n{3,}/g, '\n\n').trim()
  };
}

export function extractClockScheduleDirectivesFromContent(
  content: StandardizedMessage['content']
): { directives: ClockScheduleDirective[]; next: StandardizedMessage['content'] } {
  if (typeof content === 'string') {
    const result = extractClockScheduleDirectivesFromText(content);
    return { directives: result.directives, next: result.next };
  }
  if (Array.isArray(content)) {
    const directives: ClockScheduleDirective[] = [];
    const next = content.map((part) => {
      if (typeof part === 'string') {
        const result = extractClockScheduleDirectivesFromText(part);
        if (result.directives.length) {
          directives.push(...result.directives);
        }
        return result.next;
      }
      if (part && typeof part === 'object' && !Array.isArray(part)) {
        const block = part as Record<string, unknown>;
        const text = typeof block.text === 'string' ? block.text : undefined;
        if (!text) {
          return part;
        }
        const result = extractClockScheduleDirectivesFromText(text);
        if (result.directives.length) {
          directives.push(...result.directives);
        }
        return { ...block, text: result.next } as any;
      }
      return part;
    });
    return { directives, next };
  }
  return { directives: [], next: content };
}

export function stripClockClearDirectiveFromContent(
  content: StandardizedMessage['content']
): { hadClear: boolean; next: StandardizedMessage['content'] } {
  if (typeof content === 'string') {
    const { hadClear, next } = stripClockClearDirectiveFromText(content);
    return { hadClear, next };
  }
  if (Array.isArray(content)) {
    let hadClear = false;
    const next = content.map((part) => {
      if (typeof part === 'string') {
        const stripped = stripClockClearDirectiveFromText(part);
        if (stripped.hadClear) {
          hadClear = true;
        }
        return stripped.next;
      }
      if (part && typeof part === 'object' && !Array.isArray(part)) {
        const block = part as Record<string, unknown>;
        const text = typeof block.text === 'string' ? block.text : undefined;
        if (!text) {
          return part;
        }
        const stripped = stripClockClearDirectiveFromText(text);
        if (stripped.hadClear) {
          hadClear = true;
        }
        return { ...block, text: stripped.next } as any;
      }
      return part;
    });
    return { hadClear, next };
  }
  return { hadClear: false, next: content };
}
