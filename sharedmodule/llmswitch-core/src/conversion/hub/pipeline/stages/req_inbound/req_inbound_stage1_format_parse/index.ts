import type { AdapterContext } from "../../../../types/chat-envelope.js";
import type { FormatEnvelope } from "../../../../types/format-envelope.js";
import type { JsonObject } from "../../../../types/json.js";
import type { StageRecorder } from "../../../../format-adapters/index.js";
import { recordStage } from "../../../stages/utils.js";
import { sanitizeReqInboundFormatEnvelopeWithNative } from "../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js";
import { parseReqInboundFormatEnvelopeWithNative } from "../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js";
import {
  normalizeReasoningInAnthropicPayload,
  normalizeReasoningInChatPayload,
  normalizeReasoningInGeminiPayload,
  normalizeReasoningInResponsesPayload,
} from "../../../../../shared/reasoning-normalizer.js";
import { logHubStageTiming } from "../../../hub-stage-timing.js";

export interface ReqInboundStage1FormatParseOptions {
  rawRequest: JsonObject;
  adapterContext: AdapterContext;
  stageRecorder?: StageRecorder;
}

function resolveProtocolToken(adapterContext: AdapterContext): string {
  const candidate =
    typeof adapterContext.providerProtocol === "string" &&
    adapterContext.providerProtocol.trim().length
      ? adapterContext.providerProtocol.trim().toLowerCase()
      : "";
  if (
    candidate === "openai-chat" ||
    candidate === "openai-responses" ||
    candidate === "anthropic-messages" ||
    candidate === "gemini-chat"
  ) {
    return candidate;
  }
  return "openai-chat";
}

function applyReasoningNormalization(
  rawRequest: JsonObject,
  protocol: string,
): void {
  if (protocol === "openai-responses") {
    normalizeReasoningInResponsesPayload(
      rawRequest as unknown as Record<string, unknown>,
      {
        includeInput: true,
        includeInstructions: true,
      },
    );
    return;
  }
  if (protocol === "anthropic-messages") {
    normalizeReasoningInAnthropicPayload(rawRequest);
    return;
  }
  if (protocol === "gemini-chat") {
    normalizeReasoningInGeminiPayload(rawRequest);
    return;
  }
  normalizeReasoningInChatPayload(rawRequest as any);
}

export async function runReqInboundStage1FormatParse(
  options: ReqInboundStage1FormatParseOptions,
): Promise<FormatEnvelope<JsonObject>> {
  const requestId = options.adapterContext.requestId || "unknown";
  const protocol = resolveProtocolToken(options.adapterContext);
  logHubStageTiming(
    requestId,
    "req_inbound.stage1_reasoning_normalize",
    "start",
    { protocol },
  );
  const normalizeStart = Date.now();
  applyReasoningNormalization(options.rawRequest, protocol);
  logHubStageTiming(
    requestId,
    "req_inbound.stage1_reasoning_normalize",
    "completed",
    { elapsedMs: Date.now() - normalizeStart, protocol },
  );

  logHubStageTiming(requestId, "req_inbound.stage1_native_parse", "start");
  const parseStart = Date.now();
  const envelopeRaw = parseReqInboundFormatEnvelopeWithNative({
    rawRequest: options.rawRequest as unknown as Record<string, unknown>,
    protocol,
  }) as unknown as FormatEnvelope<JsonObject>;
  logHubStageTiming(requestId, "req_inbound.stage1_native_parse", "completed", {
    elapsedMs: Date.now() - parseStart,
  });

  logHubStageTiming(requestId, "req_inbound.stage1_sanitize", "start");
  const sanitizeStart = Date.now();
  const envelope = sanitizeReqInboundFormatEnvelopeWithNative(
    envelopeRaw,
  ) as FormatEnvelope<JsonObject>;
  logHubStageTiming(requestId, "req_inbound.stage1_sanitize", "completed", {
    elapsedMs: Date.now() - sanitizeStart,
  });
  recordStage(
    options.stageRecorder,
    "chat_process.req.stage1.format_parse",
    envelope,
  );
  return envelope;
}
