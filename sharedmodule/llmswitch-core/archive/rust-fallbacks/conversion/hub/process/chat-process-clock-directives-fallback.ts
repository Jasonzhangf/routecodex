import type { ClockDirectiveTextPart } from '../../../../../router/virtual-router/engine-selection/native-chat-process-clock-directive-parser.js';
import { parseClockScheduleDirectiveCandidatePayload } from '../../../../../conversion/hub/process/chat-process-clock-directive-parser.js';

/**
 * @deprecated Native clock directive segmentation is required; this TS fallback is retained for fixture baselines only.
 */
export function extractClockScheduleDirectiveTextPartsFallback(text: string): ClockDirectiveTextPart[] {
  const raw = String(text || '');
  const pattern = /<\*\*\s*clock\s*:\s*([\s\S]*?)\s*\*\*>/gi;
  const parts: ClockDirectiveTextPart[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(raw))) {
    const start = match.index;
    const full = match[0];
    const payload = match[1] as string;

    if (start > cursor) {
      parts.push({ kind: 'text', text: raw.slice(cursor, start) });
    }
    parts.push({
      kind: 'directive',
      full,
      candidate: parseClockScheduleDirectiveCandidatePayload(payload) ?? undefined
    });
    cursor = start + full.length;
  }

  if (cursor < raw.length) {
    parts.push({ kind: 'text', text: raw.slice(cursor) });
  }
  return parts.length ? parts : [{ kind: 'text', text: raw }];
}
