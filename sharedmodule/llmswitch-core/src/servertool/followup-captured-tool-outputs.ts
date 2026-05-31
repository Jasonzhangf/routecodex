import type { JsonObject, JsonValue } from '../conversion/hub/types/json.js';
import type { ResponsesRequestContext } from '../conversion/responses/responses-openai-bridge.js';

export interface CapturedResponsesToolOutputEntry extends JsonObject {
  tool_call_id?: string;
  call_id?: string;
  id?: string;
  output?: JsonValue;
  name?: string;
}

export function extractCapturedToolOutputs(
  responsesContext?: ResponsesRequestContext
): CapturedResponsesToolOutputEntry[] {
  if (!responsesContext || typeof responsesContext !== 'object') {
    return [];
  }
  const snapshot = (responsesContext as Record<string, unknown>).__captured_tool_results;
  if (!Array.isArray(snapshot) || !snapshot.length) {
    return [];
  }
  const entries: CapturedResponsesToolOutputEntry[] = [];
  for (const entry of snapshot) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const id = typeof row.tool_call_id === 'string' && row.tool_call_id.trim().length
      ? row.tool_call_id.trim()
      : typeof row.call_id === 'string' && row.call_id.trim().length
        ? row.call_id.trim()
        : undefined;
    if (!id) {
      continue;
    }
    entries.push({
      tool_call_id: id,
      id,
      output: row.output as JsonValue,
      ...(typeof row.name === 'string' ? { name: row.name } : {})
    });
  }
  return entries;
}
