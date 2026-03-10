import type { ChatReasoningMode } from '../types/chat-types.js';

export interface ReasoningDispatchResult {
  channel?: string;
  appendToContent?: string;
}

export interface ReasoningDispatchOptions {
  mode?: ChatReasoningMode;
  prefix?: string;
}

function formatText(text: string, prefix?: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (!prefix) return trimmed;
  const needsSpace = !prefix.endsWith(' ') && !prefix.endsWith('\n');
  return `${prefix}${needsSpace ? ' ' : ''}${trimmed}`;
}

export function dispatchReasoning(
  input: string | undefined,
  options?: ReasoningDispatchOptions
): ReasoningDispatchResult {
  const trimmed = typeof input === 'string' ? input.trim() : '';
  if (!trimmed.length) {
    return {};
  }
  const mode = options?.mode ?? 'channel';
  if (mode === 'drop') {
    return {};
  }
  if (mode === 'text') {
    return {
      appendToContent: formatText(trimmed, options?.prefix)
    };
  }
  return { channel: trimmed };
}
