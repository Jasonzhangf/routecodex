import type { StageRecorder } from "../format-adapters/index.js";
import type { JsonObject } from "../types/json.js";



function unwrapRawRequestBody(rawRequest: JsonObject): Record<string, unknown> {
  const record = rawRequest as unknown as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" && !Array.isArray(record.data)
    ? (record.data as Record<string, unknown>)
    : undefined;
  return data ?? record;
}

function extractToolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const record = tool as Record<string, unknown>;
    const fn = record.function && typeof record.function === "object" && !Array.isArray(record.function)
      ? (record.function as Record<string, unknown>)
      : undefined;
    const rawName =
      typeof fn?.name === "string" && fn.name.trim()
        ? fn.name.trim()
        : typeof record.name === "string" && record.name.trim()
          ? record.name.trim()
          : typeof record.type === "string" && record.type.trim()
            ? record.type.trim()
            : "";
    if (!rawName || seen.has(rawName)) continue;
    seen.add(rawName);
    names.push(rawName);
  }
  return names;
}

function summarizeMessageToolHistory(messages: unknown): Record<string, unknown> {
  if (!Array.isArray(messages)) {
    return { messageCount: 0, assistantToolCallTurns: 0, assistantToolCallCount: 0, toolResultTurns: 0, toolResultIds: [] };
  }
  let assistantToolCallTurns = 0;
  let assistantToolCallCount = 0;
  let toolResultTurns = 0;
  const toolResultIds: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const row = message as Record<string, unknown>;
    const role = typeof row.role === "string" ? row.role.trim().toLowerCase() : "";
    if (role === "assistant" && Array.isArray(row.tool_calls) && row.tool_calls.length > 0) {
      assistantToolCallTurns += 1;
      assistantToolCallCount += row.tool_calls.length;
    }
    if (role === "tool") {
      toolResultTurns += 1;
      const toolCallId =
        typeof row.tool_call_id === "string" && row.tool_call_id.trim()
          ? row.tool_call_id.trim()
          : typeof row.call_id === "string" && row.call_id.trim()
            ? row.call_id.trim()
            : "";
      if (toolCallId && toolResultIds.length < 32) toolResultIds.push(toolCallId);
    }
  }
  return { messageCount: messages.length, assistantToolCallTurns, assistantToolCallCount, toolResultTurns, toolResultIds };
}

export function recordOutboundToolParityObservation(args: {
  rawRequest: JsonObject;
  providerPayload: Record<string, unknown>;
  providerProtocol: string;
  compatibilityProfile?: string;
  requestId: string;
  stageRecorder?: StageRecorder;
}): void {
  if (!args.stageRecorder) {
    return;
  }

  const inboundBody = unwrapRawRequestBody(args.rawRequest);
  const inboundNames = extractToolNames(inboundBody.tools);
  const outboundNames = extractToolNames(args.providerPayload.tools);
  const outboundSet = new Set(outboundNames);
  const inboundSet = new Set(inboundNames);
  const missingNames = inboundNames.filter((name) => !outboundSet.has(name));
  const extraNames = outboundNames.filter((name) => !inboundSet.has(name));

  args.stageRecorder.record("chat_process.req.stage8b.outbound.tool_parity", {
    requestId: args.requestId,
    providerProtocol: args.providerProtocol,
    compatibilityProfile: args.compatibilityProfile ?? null,
    inboundTools: {
      count: Array.isArray(inboundBody.tools) ? inboundBody.tools.length : 0,
      names: inboundNames,
    },
    outboundTools: {
      count: Array.isArray(args.providerPayload.tools)
        ? args.providerPayload.tools.length
        : 0,
      names: outboundNames,
    },
    missingNames,
    extraNames,
    matched: missingNames.length === 0 && extraNames.length === 0,
    inboundHistory: summarizeMessageToolHistory(inboundBody.messages),
    outboundHistory: summarizeMessageToolHistory(args.providerPayload.messages),
  });
}
