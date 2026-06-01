export type ToolHistoryContractViolationCode =
  | 'missing_tool_call_id'
  | 'synthetic_tool_call_id'
  | 'synthetic_local_control_text'
  | 'orphan_tool_result'
  | 'dangling_tool_call';

export type ToolHistoryContractViolation = {
  code: ToolHistoryContractViolationCode;
  index: number;
  callId?: string;
  role?: string;
  itemType?: string;
  reason: string;
};

const SYNTHETIC_SERVERTOOL_ID_PATTERNS: RegExp[] = [
  /^call_servertool_fallback_/i
];

export function isSyntheticRouteCodexToolCallId(callId: string | undefined): boolean {
  if (!callId) {
    return false;
  }
  return SYNTHETIC_SERVERTOOL_ID_PATTERNS.some((pattern) => pattern.test(callId));
}

export function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
