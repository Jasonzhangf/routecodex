import type { StageRecorder } from "../format-adapters/index.js";
import type { JsonObject } from "../types/json.js";
import {
  extractToolNames,
  summarizeMessageToolHistory,
  unwrapRawRequestBody,
} from "./hub-pipeline-provider-payload-observation-blocks.js";

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
