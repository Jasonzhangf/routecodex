import type { StandardizedMessage } from '../../../conversion/hub/types/standardized.js';
import type { RouterMetadataInput } from '../types.js';
import type { RoutingInstructionState } from '../routing-instructions.js';
import { extractMessageText } from '../message-utils.js';

export const DEFAULT_STOP_MESSAGE_MAX_REPEATS = 10;

export function isStopScopeTraceEnabled(): boolean {
  const raw = String(process.env.ROUTECODEX_STOP_SCOPE_TRACE ?? process.env.RCC_STOP_SCOPE_TRACE ?? '')
    .trim()
    .toLowerCase();
  return (
    raw === '1' ||
    raw === 'true' ||
    raw === 'on' ||
    raw === 'yes' ||
    raw === 'debug' ||
    raw === 'trace' ||
    raw === 'verbose'
  );
}

export function normalizeStopMessageStageMode(value: unknown): 'on' | 'off' | 'auto' | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'on' || normalized === 'off' || normalized === 'auto') {
    return normalized;
  }
  return undefined;
}

export function normalizeStopMessageAiMode(value: unknown): 'on' | 'off' | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'on' || normalized === 'off') {
    return normalized;
  }
  return undefined;
}

export function stripStopMessageFields(state: RoutingInstructionState): RoutingInstructionState {
  return {
    ...state,
    stopMessageSource: undefined,
    stopMessageText: undefined,
    stopMessageMaxRepeats: undefined,
    stopMessageUsed: undefined,
    stopMessageUpdatedAt: undefined,
    stopMessageLastUsedAt: undefined,
    stopMessageStageMode: undefined,
    stopMessageAiMode: undefined,
    stopMessageAiSeedPrompt: undefined,
    stopMessageAiHistory: undefined
  };
}

export function stripClientInjectScopedFields(state: RoutingInstructionState): RoutingInstructionState {
  return {
    ...stripStopMessageFields(state),
    preCommandSource: undefined,
    preCommandScriptPath: undefined,
    preCommandUpdatedAt: undefined
  };
}

export function hasClientInjectScopedFields(state: RoutingInstructionState | null | undefined): boolean {
  if (!state) {
    return false;
  }
  return (
    typeof state.stopMessageText === 'string' ||
    typeof state.stopMessageMaxRepeats === 'number' ||
    typeof state.stopMessageUsed === 'number' ||
    typeof state.stopMessageStageMode === 'string' ||
    typeof state.stopMessageAiMode === 'string' ||
    typeof state.stopMessageAiSeedPrompt === 'string' ||
    Array.isArray(state.stopMessageAiHistory) ||
    typeof state.preCommandScriptPath === 'string' ||
    typeof state.preCommandUpdatedAt === 'number'
  );
}

export function hasRoutingInstructionMarker(messages: StandardizedMessage[]): boolean {
  for (const message of messages) {
    if (!message || message.role !== 'user') {
      continue;
    }
    const content = extractMessageText(message);
    if (!content) {
      continue;
    }
    if (/<\*\*[\s\S]*?\*\*>/.test(content)) {
      return true;
    }
  }
  return false;
}

export function hasLatestUserRoutingInstructionMarker(messages: StandardizedMessage[]): boolean {
  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    const message = messages[idx];
    if (!message) {
      continue;
    }
    if (message.role !== 'user') {
      continue;
    }
    const content = extractMessageText(message);
    if (!content) {
      return false;
    }
    return /<\*\*[\s\S]*?\*\*>/.test(content);
  }
  return false;
}

function extractResponsesInputText(entry: Record<string, unknown>): string {
  if (typeof entry.content === 'string' && entry.content.trim()) {
    return entry.content;
  }
  if (Array.isArray(entry.content)) {
    return extractMessageText({ role: 'user', content: entry.content } as StandardizedMessage);
  }
  return '';
}

export function getLatestUserTextFromResponsesContext(context: unknown): string {
  if (!context || typeof context !== 'object') {
    return '';
  }
  const input = (context as { input?: unknown }).input;
  if (!Array.isArray(input) || input.length === 0) {
    return '';
  }
  for (let idx = input.length - 1; idx >= 0; idx -= 1) {
    const entry = input[idx];
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const entryType = typeof record.type === 'string' ? record.type.trim().toLowerCase() : 'message';
    if (entryType !== 'message') {
      continue;
    }
    const role = typeof record.role === 'string' ? record.role.trim().toLowerCase() : 'user';
    if (role !== 'user') {
      continue;
    }
    const text = extractResponsesInputText(record).trim();
    if (text) {
      return text;
    }
  }
  return '';
}

export function hasRoutingInstructionMarkerInResponsesContext(context: unknown): boolean {
  const latestUserText = getLatestUserTextFromResponsesContext(context);
  if (!latestUserText) {
    return false;
  }
  return /<\*\*[\s\S]*?\*\*>/.test(latestUserText);
}

export function cleanResponsesContextFromRoutingInstructions(context: unknown): void {
  if (!context || typeof context !== 'object') {
    return;
  }
  const record = context as { input?: unknown };
  if (!Array.isArray(record.input)) {
    return;
  }
  const cleaned = record.input
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return entry;
      }
      const row = entry as Record<string, unknown>;
      const entryType = typeof row.type === 'string' ? row.type.trim().toLowerCase() : 'message';
      if (entryType !== 'message') {
        return entry;
      }
      const role = typeof row.role === 'string' ? row.role.trim().toLowerCase() : 'user';
      if (role !== 'user') {
        return entry;
      }
      if (typeof row.content === 'string') {
        const cleanedText = row.content.replace(/<\*\*[\s\S]*?\*\*>/g, '').trim();
        if (!cleanedText) {
          return null;
        }
        return { ...row, content: cleanedText };
      }
      if (Array.isArray(row.content)) {
        const nextContent = row.content
          .map((part) => {
            if (typeof part === 'string') {
              const cleanedText = part.replace(/<\*\*[\s\S]*?\*\*>/g, '').trim();
              return cleanedText ? cleanedText : null;
            }
            if (!part || typeof part !== 'object' || Array.isArray(part)) {
              return part;
            }
            const partRecord = part as { text?: unknown; content?: unknown };
            if (typeof partRecord.text === 'string') {
              const cleanedText = partRecord.text.replace(/<\*\*[\s\S]*?\*\*>/g, '').trim();
              if (!cleanedText) {
                return null;
              }
              return { ...partRecord, text: cleanedText };
            }
            if (typeof partRecord.content === 'string') {
              const cleanedText = partRecord.content.replace(/<\*\*[\s\S]*?\*\*>/g, '').trim();
              if (!cleanedText) {
                return null;
              }
              return { ...partRecord, content: cleanedText };
            }
            return part;
          })
          .filter((part) => part !== null);
        if (!nextContent.length) {
          return null;
        }
        return { ...row, content: nextContent };
      }
      return entry;
    })
    .filter((entry) => entry !== null);
  record.input = cleaned;
}

export function isServerToolFollowupRequest(metadata: RouterMetadataInput): boolean {
  if (!metadata || typeof metadata !== 'object') {
    return false;
  }
  const rt = (metadata as unknown as Record<string, unknown>).__rt;
  if (!rt || typeof rt !== 'object' || Array.isArray(rt)) {
    return false;
  }
  const flag = (rt as Record<string, unknown>).serverToolFollowup;
  return flag === true || (typeof flag === 'string' && flag.trim().toLowerCase() === 'true');
}
