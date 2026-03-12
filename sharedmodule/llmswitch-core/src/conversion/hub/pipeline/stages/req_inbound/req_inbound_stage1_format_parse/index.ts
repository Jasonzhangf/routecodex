import type { AdapterContext } from "../../../../types/chat-envelope.js";
import type { FormatEnvelope } from "../../../../types/format-envelope.js";
import type { JsonObject } from "../../../../types/json.js";
import type { StageRecorder } from "../../../../format-adapters/index.js";
import { valueMayContainReasoningMarkup } from "../../../../../shared/reasoning-normalizer.js";
import { recordStage } from "../../../stages/utils.js";
import {
  normalizeReqInboundReasoningPayloadWithNative,
  sanitizeReqInboundFormatEnvelopeWithNative,
} from "../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js";
import { parseReqInboundFormatEnvelopeWithNative } from "../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js";
import { logHubStageTiming } from "../../../hub-stage-timing.js";

export interface ReqInboundStage1FormatParseOptions {
  rawRequest: JsonObject;
  adapterContext: AdapterContext;
  stageRecorder?: StageRecorder;
}

interface ResponsesReasoningTarget {
  field: "input" | "output";
  index: number;
}

interface ReqInboundReasoningNormalizeResult {
  normalizedRequest: JsonObject;
  strategy: "fast_path" | "native";
  target?: string;
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

function shouldNormalizeReqInboundReasoningPayload(
  payload: JsonObject,
  protocol: string,
): boolean {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  switch (protocol) {
    case "openai-chat":
      return (
        valueMayContainReasoningMarkup(payload.messages) ||
        valueMayContainReasoningMarkup(payload.choices)
      );
    case "openai-responses":
      return responsesPayloadMayContainReasoningMarkup(payload);
    case "anthropic-messages":
      return (
        valueMayContainReasoningMarkup(payload.messages) ||
        valueMayContainReasoningMarkup(payload.content)
      );
    case "gemini-chat":
      return (
        valueMayContainReasoningMarkup(payload.contents) ||
        valueMayContainReasoningMarkup(payload.candidates)
      );
    default:
      return valueMayContainReasoningMarkup(payload);
  }
}

function responsesPayloadMayContainReasoningMarkup(payload: JsonObject): boolean {
  const latestOutputTarget = findLatestResponsesReasoningTarget(payload.output, "output");
  if (latestOutputTarget) {
    const outputItems = payload.output as unknown[];
    if (responsesItemMayContainReasoningMarkup(outputItems[latestOutputTarget.index])) {
      return true;
    }
  }

  const latestInputTarget = findLatestResponsesReasoningTarget(payload.input, "input");
  if (latestInputTarget) {
    const inputItems = payload.input as unknown[];
    if (responsesItemMayContainReasoningMarkup(inputItems[latestInputTarget.index])) {
      return true;
    }
  }

  return (
    valueMayContainReasoningMarkup(payload.instructions) ||
    valueMayContainReasoningMarkup(payload.required_action)
  );
}

function findLatestResponsesReasoningTarget(
  value: unknown,
  field: ResponsesReasoningTarget["field"],
): ResponsesReasoningTarget | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (responsesItemIsReasoningCarrier(value[index])) {
      return { field, index };
    }
  }
  return undefined;
}

function responsesItemIsReasoningCarrier(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  const role = typeof record.role === "string" ? record.role.toLowerCase() : "";
  return (
    type === "message" ||
    type === "reasoning" ||
    type === "output_text" ||
    type === "text" ||
    role === "assistant" ||
    role === "model" ||
    role === "system"
  );
}

function responsesItemMayContainReasoningMarkup(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    responsesContentMayContainReasoningMarkup(record.content) ||
    responsesContentMayContainReasoningMarkup(record.text)
  ) {
    return true;
  }
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if (type !== "reasoning") {
    return false;
  }
  return (
    responsesContentMayContainReasoningMarkup(record.summary) ||
    responsesContentMayContainReasoningMarkup(record.reasoning)
  );
}

function responsesContentMayContainReasoningMarkup(value: unknown): boolean {
  if (typeof value === "string") {
    return valueMayContainReasoningMarkup(value);
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (responsesContentMayContainReasoningMarkup(entry)) {
        return true;
      }
    }
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string" && valueMayContainReasoningMarkup(record.text)) {
    return true;
  }
  if (typeof record.content === "string" && valueMayContainReasoningMarkup(record.content)) {
    return true;
  }
  if (Array.isArray(record.content)) {
    return responsesContentMayContainReasoningMarkup(record.content);
  }
  return false;
}

function normalizeLatestResponsesReasoningTarget(
  payload: JsonObject,
  target: ResponsesReasoningTarget,
): JsonObject {
  const sourceItems = payload[target.field];
  if (!Array.isArray(sourceItems)) {
    return payload;
  }
  const current = sourceItems[target.index];
  if (!current || typeof current !== "object") {
    return payload;
  }
  const normalizedSlice = normalizeReqInboundReasoningPayloadWithNative({
    payload: {
      [target.field]: [current as Record<string, unknown>],
    },
    protocol: "openai-responses",
  }) as Record<string, unknown>;
  const normalizedItems = normalizedSlice[target.field];
  if (!Array.isArray(normalizedItems) || normalizedItems.length === 0) {
    return payload;
  }
  const nextItems = [...sourceItems];
  nextItems[target.index] = normalizedItems[0];
  return {
    ...payload,
    [target.field]: nextItems,
  };
}

function normalizeReqInboundReasoningPayload(
  payload: JsonObject,
  protocol: string,
): ReqInboundReasoningNormalizeResult {
  if (!shouldNormalizeReqInboundReasoningPayload(payload, protocol)) {
    return {
      normalizedRequest: payload,
      strategy: "fast_path",
    };
  }

  if (protocol === "openai-responses") {
    const latestOutputTarget = findLatestResponsesReasoningTarget(payload.output, "output");
    if (latestOutputTarget) {
      const outputItems = payload.output as unknown[];
      if (responsesItemMayContainReasoningMarkup(outputItems[latestOutputTarget.index])) {
        return {
          normalizedRequest: normalizeLatestResponsesReasoningTarget(
            payload,
            latestOutputTarget,
          ),
          strategy: "native",
          target: `output[${latestOutputTarget.index}]`,
        };
      }
    }

    const latestInputTarget = findLatestResponsesReasoningTarget(payload.input, "input");
    if (latestInputTarget) {
      const inputItems = payload.input as unknown[];
      if (responsesItemMayContainReasoningMarkup(inputItems[latestInputTarget.index])) {
        return {
          normalizedRequest: normalizeLatestResponsesReasoningTarget(
            payload,
            latestInputTarget,
          ),
          strategy: "native",
          target: `input[${latestInputTarget.index}]`,
        };
      }
    }
  }

  return {
    normalizedRequest: normalizeReqInboundReasoningPayloadWithNative({
      payload: payload as unknown as Record<string, unknown>,
      protocol,
    }) as JsonObject,
    strategy: "native",
  };
}

function approximateJsonBytes(value: unknown): number | undefined {
  try {
    return JSON.stringify(value)?.length;
  } catch {
    return undefined;
  }
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
  const reasoningNormalize = normalizeReqInboundReasoningPayload(
    options.rawRequest,
    protocol,
  );
  const normalizedRequest = reasoningNormalize.normalizedRequest;
  logHubStageTiming(
    requestId,
    "req_inbound.stage1_reasoning_normalize",
    "completed",
    {
      elapsedMs: Date.now() - normalizeStart,
      protocol,
      strategy: reasoningNormalize.strategy,
      target: reasoningNormalize.target,
      approxBytes: approximateJsonBytes(options.rawRequest),
      inputItems: Array.isArray((options.rawRequest as Record<string, unknown>).input)
        ? ((options.rawRequest as Record<string, unknown>).input as unknown[]).length
        : undefined,
      outputItems: Array.isArray((options.rawRequest as Record<string, unknown>).output)
        ? ((options.rawRequest as Record<string, unknown>).output as unknown[]).length
        : undefined,
    },
  );

  logHubStageTiming(requestId, "req_inbound.stage1_native_parse", "start");
  const parseStart = Date.now();
  const envelopeRaw = parseReqInboundFormatEnvelopeWithNative({
    rawRequest: normalizedRequest as unknown as Record<string, unknown>,
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
