export const STREAM_LOG_FINISH_REASON_KEY = "__routecodex_finish_reason";

const FINISH_REASON_DEBUG_ENABLED =
  process.env.ROUTECODEX_DEBUG_FINISH_REASON === '1' ||
  process.env.RCC_DEBUG_FINISH_REASON === '1';

function logFinishReasonDebug(...args: unknown[]): void {
  if (!FINISH_REASON_DEBUG_ENABLED) {
    return;
  }
  // eslint-disable-next-line no-console
  console.log(...args);
}

export function deriveFinishReason(body: unknown): string | undefined {
  logFinishReasonDebug(
    '[FINISH-REASON:DEBUG] input body keys:',
    body && typeof body === 'object' ? Object.keys(body as any).join(',') : typeof body
  );
  logFinishReasonDebug('[FINISH-REASON:DEBUG] choices:', JSON.stringify((body as any)?.choices)?.slice(0, 200));
  logFinishReasonDebug('[FINISH-REASON:DEBUG] output:', JSON.stringify((body as any)?.output)?.slice(0, 300));
  logFinishReasonDebug('[FINISH-REASON:DEBUG] status:', (body as any)?.status);
  logFinishReasonDebug(
    '[FINISH-REASON:DEBUG] required_action:',
    JSON.stringify((body as any)?.required_action)?.slice(0, 200)
  );
  logFinishReasonDebug('[FINISH-REASON:DEBUG] stop_reason:', (body as any)?.stop_reason);
  const record = resolveFinishReasonRecord(body);
  if (!record) {
    return undefined;
  }

  const choices = Array.isArray(record.choices) ? record.choices : [];
  const firstChoice = asRecord(choices[0]);
  const choiceFinishReason = readNonEmptyString(firstChoice?.finish_reason);
  if (choiceFinishReason) {
    return choiceFinishReason;
  }

  const stopReason = readNonEmptyString(record.stop_reason);
  if (stopReason) {
    return mapStopReasonToFinishReason(stopReason);
  }

  if (hasChatChoiceToolCalls(firstChoice)) {
    return "tool_calls";
  }

  const responseStatus = readNonEmptyString(record.status)?.toLowerCase();
  if (hasResponsesToolCall(record)) {
    logFinishReasonDebug('[FINISH-REASON:DEBUG] hasResponsesToolCall=true -> tool_calls');
    return "tool_calls";
  }

  const incompleteReason = readNonEmptyString(asRecord(record.incomplete_details)?.reason);
  if (incompleteReason) {
    return mapIncompleteReasonToFinishReason(incompleteReason);
  }

  logFinishReasonDebug('[FINISH-REASON:DEBUG] responseStatus:', responseStatus);
  if (responseStatus === "completed") {
    logFinishReasonDebug('[FINISH-REASON:DEBUG] status=completed -> stop');
    return "stop";
  }
  if (responseStatus === "requires_action") {
    return "tool_calls";
  }

  const wrappedFinishReason = readNonEmptyString(record[STREAM_LOG_FINISH_REASON_KEY]);
  if (wrappedFinishReason) {
    return wrappedFinishReason;
  }

  if (hasChatChoiceAssistantContent(firstChoice)) {
    return "stop";
  }

  return undefined;
}

function resolveFinishReasonRecord(body: unknown): Record<string, unknown> | null {
  const root = asRecord(body);
  if (!root) {
    return null;
  }
  const nestedCandidates = ['data', 'response', 'payload'] as const;
  for (const key of nestedCandidates) {
    const nested = asRecord(root[key]);
    if (!nested) {
      continue;
    }
    if (
      Array.isArray(nested.choices) ||
      Array.isArray(nested.output) ||
      typeof nested.stop_reason === 'string' ||
      typeof nested.status === 'string' ||
      typeof nested[STREAM_LOG_FINISH_REASON_KEY] === 'string'
    ) {
      return nested;
    }
  }
  return root;
}

function hasResponsesToolCall(record: Record<string, unknown>): boolean {
  const requiredAction = asRecord(record.required_action);
  if (asRecord(requiredAction?.submit_tool_outputs)) {
    return true;
  }

  const output = Array.isArray(record.output) ? record.output : [];
  return output.some((item) => {
    const type = readNonEmptyString(asRecord(item)?.type)?.toLowerCase();
    return type === "function_call" || type === "tool_call";
  });
}

function hasChatChoiceToolCalls(choice: Record<string, unknown> | null): boolean {
  if (!choice) {
    return false;
  }
  const message = asRecord(choice.message);
  if (!message) {
    return false;
  }
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return toolCalls.length > 0;
}

function hasChatChoiceAssistantContent(choice: Record<string, unknown> | null): boolean {
  if (!choice) {
    return false;
  }
  const message = asRecord(choice.message);
  if (!message) {
    return false;
  }
  const content = message.content;
  if (typeof content === 'string') {
    return content.trim().length > 0;
  }
  if (Array.isArray(content)) {
    return content.length > 0;
  }
  return false;
}

function mapStopReasonToFinishReason(stopReason: string): string {
  const normalized = stopReason.trim().toLowerCase();
  switch (normalized) {
    case "end_turn":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      return normalized;
  }
}

function mapIncompleteReasonToFinishReason(reason: string): string {
  const normalized = reason.trim().toLowerCase();
  switch (normalized) {
    case "max_output_tokens":
    case "max_tokens":
      return "length";
    default:
      return normalized;
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
