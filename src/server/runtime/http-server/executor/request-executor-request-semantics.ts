import { formatUnknownError, isRecord } from '../../../../utils/common-utils.js';

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}


function readServerToolFollowupSource(requestSemantics?: Record<string, unknown>): string {
  const routecodex =
    requestSemantics?.__routecodex && typeof requestSemantics.__routecodex === 'object' && !Array.isArray(requestSemantics.__routecodex)
      ? (requestSemantics.__routecodex as Record<string, unknown>)
      : undefined;
  const raw = routecodex?.serverToolFollowupSource;
  return typeof raw === 'string' && raw.trim().length ? raw.trim() : '';
}

function isReasoningStopFollowupTurn(requestSemantics?: Record<string, unknown>): boolean {
  const source = readServerToolFollowupSource(requestSemantics);
  return source === 'servertool.reasoning_stop_guard' || source === 'servertool.reasoning_stop_continue';
}

export function hasRequestedToolsInSemantics(requestSemantics?: Record<string, unknown>): boolean {
  if (!requestSemantics || typeof requestSemantics !== 'object') {
    return false;
  }
  const toolsNode =
    requestSemantics.tools && typeof requestSemantics.tools === 'object' && !Array.isArray(requestSemantics.tools)
      ? (requestSemantics.tools as Record<string, unknown>)
      : undefined;
  const candidates = [requestSemantics.tools, toolsNode?.clientToolsRaw, toolsNode?.baselineTools];
  return candidates.some((candidate) => Array.isArray(candidate) && candidate.length > 0);
}

export function isToolResultFollowupTurn(requestSemantics?: Record<string, unknown>): boolean {
  if (isReasoningStopFollowupTurn(requestSemantics)) {
    return false;
  }
  const messages = Array.isArray(requestSemantics?.messages) ? requestSemantics.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message)) {
      continue;
    }
    const role = readString(message.role)?.toLowerCase() ?? '';
    if (role === 'tool' || role === 'function') {
      return true;
    }
    if (typeof message.tool_call_id === 'string' && message.tool_call_id.trim().length > 0) {
      return true;
    }
    const type = readString(message.type)?.toLowerCase() ?? '';
    if (type === 'function_call_output' || type === 'tool_result' || type === 'tool_message') {
      return true;
    }
    if (role === 'assistant' || role === 'user' || type.length > 0) {
      return false;
    }
  }
  return false;
}
