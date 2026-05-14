import type { JsonObject } from "../types/json.js";
import type { StandardizedRequest } from "../types/standardized.js";
import type { HubPipelineConfig, NormalizedRequest } from "./hub-pipeline.js";
import { coerceStandardizedRequestFromPayloadWithNative } from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import { buildAdapterContextFromNormalized } from "./hub-pipeline-adapter-context.js";
import {
  propagateApplyPatchToolModeToRequestMetadata,
  resolveActiveProcessModeAndAudit,
  sanitizeStandardizedRequestMessages,
} from "./hub-pipeline-chat-process-request-utils.js";
import {
  applyChatProcessSemanticGate,
  createChatProcessSnapshotRecorder,
  prepareChatProcessRuntimeMetadata,
} from "./hub-pipeline-chat-process-entry-blocks.js";
import { requireJsonObjectPayload } from "./hub-pipeline-shared-guards.js";

export function coerceChatProcessEntryPayload(normalized: NormalizedRequest): {
  rawPayloadInput: JsonObject;
  rawPayload: Record<string, unknown>;
  standardizedRequestBase: StandardizedRequest;
} {
  const rawPayloadInput = requireJsonObjectPayload(normalized);
  const coerced = coerceStandardizedRequestFromPayloadWithNative({
    payload: rawPayloadInput as Record<string, unknown>,
    normalized: {
      id: normalized.id,
      entryEndpoint: normalized.entryEndpoint,
      stream: normalized.stream,
      processMode: normalized.processMode,
      routeHint: normalized.routeHint,
    },
  });
  return {
    rawPayloadInput,
    rawPayload: coerced.rawPayload,
    standardizedRequestBase:
      coerced.standardizedRequest as unknown as StandardizedRequest,
  };
}

export function prepareChatProcessEntryExecutionContext(args: {
  normalized: NormalizedRequest;
  config: HubPipelineConfig;
  standardizedRequestBase: StandardizedRequest;
  rawPayload: Record<string, unknown>;
}): {
  metaBase: Record<string, unknown>;
  standardizedRequest: StandardizedRequest;
  activeProcessMode: "chat" | "passthrough";
  passthroughAudit?: Record<string, unknown>;
  stageRecorder: ReturnType<typeof createChatProcessSnapshotRecorder>;
} {
  const metaBase = prepareChatProcessRuntimeMetadata({
    normalized: args.normalized,
    config: args.config,
  });

  let standardizedRequest: StandardizedRequest =
    sanitizeStandardizedRequestMessages(args.standardizedRequestBase);
  const { activeProcessMode, passthroughAudit } =
    resolveActiveProcessModeAndAudit({
      normalized: args.normalized,
      requestMessages: standardizedRequest.messages,
      rawPayload: args.rawPayload,
    });
  standardizedRequest = applyChatProcessSemanticGate({
    request: standardizedRequest,
    metadata: metaBase,
    requestId: args.normalized.id,
  });
  propagateApplyPatchToolModeToRequestMetadata(metaBase, standardizedRequest);

  const adapterContext = buildAdapterContextFromNormalized(args.normalized);
  const stageRecorder = createChatProcessSnapshotRecorder({
    normalized: args.normalized,
    adapterContext,
    warningLabel: "Snapshot recorder creation",
  });

  return {
    metaBase,
    standardizedRequest,
    activeProcessMode,
    passthroughAudit,
    stageRecorder,
  };
}
