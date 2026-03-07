export const STREAM_LOG_FINISH_REASON_KEY = "__routecodex_finish_reason";

export function deriveFinishReason(body: unknown): string | undefined {
  const record = asRecord(body);
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

  const responseStatus = readNonEmptyString(record.status)?.toLowerCase();
  if (hasResponsesToolCall(record)) {
    return "tool_calls";
  }

  const incompleteReason = readNonEmptyString(asRecord(record.incomplete_details)?.reason);
  if (incompleteReason) {
    return mapIncompleteReasonToFinishReason(incompleteReason);
  }

  if (responseStatus === "completed") {
    return "stop";
  }
  if (responseStatus === "requires_action") {
    return "tool_calls";
  }

  return readNonEmptyString(record[STREAM_LOG_FINISH_REASON_KEY]);
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
