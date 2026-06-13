import { deriveFinishReasonNative } from '../../modules/llmswitch/bridge.js';

export const STREAM_LOG_FINISH_REASON_KEY = "__routecodex_finish_reason";

const FINISH_REASON_DEBUG_ENABLED =
  process.env.ROUTECODEX_DEBUG_FINISH_REASON === '1' ||
  process.env.RCC_DEBUG_FINISH_REASON === '1';

function logFinishReasonDebug(...args: unknown[]): void {
  if (!FINISH_REASON_DEBUG_ENABLED) {
    return;
  }
  console.log(...args);
}

export function deriveFinishReason(body: unknown): string | undefined {
  logFinishReasonDebug(
    '[FINISH-REASON:DEBUG] input body keys:',
    body && typeof body === 'object' ? Object.keys(body as Record<string, unknown>).join(',') : typeof body
  );
  const finishReason = deriveFinishReasonNative(body);
  logFinishReasonDebug('[FINISH-REASON:DEBUG] derived:', finishReason);
  return finishReason;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasVisibleText(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasVisibleText(entry));
  }
  if (!isRecord(value)) {
    return false;
  }
  const entryType = typeof value.type === 'string' ? value.type.trim().toLowerCase() : '';
  if (entryType === 'reasoning' || entryType === 'thinking') {
    return false;
  }
  return hasVisibleText(value.text) || hasVisibleText(value.output_text) || hasVisibleText(value.content);
}

function hasToolCalls(body: Record<string, unknown>): boolean {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choiceToolCall = choices.some((choice) => {
    if (!isRecord(choice)) {
      return false;
    }
    const message = isRecord(choice.message) ? choice.message : undefined;
    return Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
  });
  if (choiceToolCall) {
    return true;
  }
  const requiredAction = isRecord(body.required_action) ? body.required_action : undefined;
  const submit = isRecord(requiredAction?.submit_tool_outputs) ? requiredAction.submit_tool_outputs : undefined;
  if (Array.isArray(submit?.tool_calls) && submit.tool_calls.length > 0) {
    return true;
  }
  const output = Array.isArray(body.output) ? body.output : [];
  return output.some((item) => {
    if (!isRecord(item)) {
      return false;
    }
    const itemType = typeof item.type === 'string' ? item.type.trim().toLowerCase() : '';
    return itemType === 'function_call' || itemType === 'function' || (Array.isArray(item.tool_calls) && item.tool_calls.length > 0);
  });
}

function hasVisibleAssistantSuccess(body: Record<string, unknown>): boolean {
  if (typeof body.output_text === 'string' && body.output_text.trim()) {
    return true;
  }
  const choices = Array.isArray(body.choices) ? body.choices : [];
  if (
    choices.some((choice) => {
      if (!isRecord(choice)) {
        return false;
      }
      const message = isRecord(choice.message) ? choice.message : undefined;
      return hasVisibleText(message?.content);
    })
  ) {
    return true;
  }
  const output = Array.isArray(body.output) ? body.output : [];
  return output.some((item) => {
    if (!isRecord(item)) {
      return false;
    }
    const itemType = typeof item.type === 'string' ? item.type.trim().toLowerCase() : '';
    if (itemType === 'function_call' || itemType === 'function') {
      return false;
    }
    if (itemType === 'message' && typeof item.role === 'string' && item.role.trim().toLowerCase() !== 'assistant') {
      return false;
    }
    return hasVisibleText(item.output_text) || hasVisibleText(item.content) || hasVisibleText(item.text);
  });
}

export function deriveFinishReasonWithVisibleSuccessFallback(body: unknown): string | undefined {
  const derived = deriveFinishReason(body);
  if (derived) {
    return derived;
  }
  if (!isRecord(body)) {
    return undefined;
  }
  if (hasToolCalls(body)) {
    return 'tool_calls';
  }
  if (hasVisibleAssistantSuccess(body)) {
    return 'stop';
  }
  return undefined;
}
