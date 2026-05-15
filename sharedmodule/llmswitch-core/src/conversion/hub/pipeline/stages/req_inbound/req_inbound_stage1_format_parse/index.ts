import type { AdapterContext } from "../../../../types/chat-envelope.js";
import type { FormatEnvelope } from "../../../../types/format-envelope.js";
import type { JsonObject } from "../../../../types/json.js";
import type { StageRecorder } from "../../../../format-adapters/index.js";
import { recordStage } from "../../../stages/utils.js";
import {
  normalizeReasoningPayloadV2WithNative,
  shouldNormalizeReasoningPayloadWithNative,
  sanitizeReqInboundFormatEnvelopeWithNative,
} from "../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js";
import { parseReqInboundFormatEnvelopeWithNative } from "../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js";
import { logHubStageTiming } from "../../../hub-stage-timing.js";
import { resolveHubProviderProtocolWithNative } from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics-protocol.js';

export interface ReqInboundStage1FormatParseOptions {
  rawRequest: JsonObject;
  adapterContext: AdapterContext;
  stageRecorder?: StageRecorder;
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
  const protocol = resolveHubProviderProtocolWithNative(options.adapterContext.providerProtocol);

  logHubStageTiming(
    requestId,
    "req_inbound.stage1_reasoning_normalize",
    "start",
    { protocol },
  );

  const normalizeStart = Date.now();
  const payload = options.rawRequest as unknown as Record<string, unknown>;
  const reasoningNormalize = shouldNormalizeReasoningPayloadWithNative(payload, protocol)
    ? normalizeReasoningPayloadV2WithNative({ payload, protocol })
    : { normalizedRequest: options.rawRequest, strategy: "skip" as const };
  const normalizedRequest = reasoningNormalize.normalizedRequest as JsonObject;

  logHubStageTiming(
    requestId,
    "req_inbound.stage1_reasoning_normalize",
    "completed",
    {
      elapsedMs: Date.now() - normalizeStart,
      protocol,
      strategy: reasoningNormalize.strategy,
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
