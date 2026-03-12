import type {
  AdapterContext,
  ChatEnvelope,
} from "../../../../types/chat-envelope.js";
import type { FormatEnvelope } from "../../../../types/format-envelope.js";
import {
  isJsonObject,
  jsonClone,
  type JsonObject,
} from "../../../../types/json.js";
import type {
  SemanticMapper,
  StageRecorder,
} from "../../../../format-adapters/index.js";
import type { StandardizedRequest } from "../../../../types/standardized.js";
import { applyHubOperationTableInbound } from "../../../../operation-table/operation-table-runner.js";
import { recordStage } from "../../../stages/utils.js";
import { liftReqInboundSemantics } from "./semantic-lift.js";
import { validateChatEnvelopeWithNative } from "../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js";
import { chatEnvelopeToStandardizedWithNative } from "../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js";
import {
  isHubStageTimingDetailEnabled,
  logHubStageTiming,
} from "../../../hub-stage-timing.js";

export interface ReqInboundStage2SemanticMapOptions {
  adapterContext: AdapterContext;
  formatEnvelope: FormatEnvelope<JsonObject>;
  semanticMapper: Pick<SemanticMapper, "toChat">;
  /**
   * Mappable cross-protocol semantics (e.g. /v1/responses submit resume) must be
   * lifted into chat semantics before entering chat_process.
   *
   * This must never be stored in metadata/AdapterContext.
   */
  responsesResume?: JsonObject;
  stageRecorder?: StageRecorder;
}

export interface ReqInboundStage2SemanticMapResult {
  chatEnvelope: ChatEnvelope;
  standardizedRequest: StandardizedRequest;
  responsesContext?: JsonObject;
}

export async function runReqInboundStage2SemanticMap(
  options: ReqInboundStage2SemanticMapOptions,
): Promise<ReqInboundStage2SemanticMapResult> {
  const requestId = options.adapterContext.requestId || "unknown";
  const forceDetailLog = isHubStageTimingDetailEnabled();
  logHubStageTiming(
    requestId,
    "req_inbound.stage2_semantic_mapper_toChat",
    "start",
  );
  const toChatStart = Date.now();
  const chatEnvelope = await options.semanticMapper.toChat(
    options.formatEnvelope,
    options.adapterContext,
  );
  logHubStageTiming(
    requestId,
    "req_inbound.stage2_semantic_mapper_toChat",
    "completed",
    { elapsedMs: Date.now() - toChatStart },
  );

  const preservedResponsesContext = (() => {
    if (!chatEnvelope.semantics || typeof chatEnvelope.semantics !== "object") {
      return undefined;
    }
    const semantics = chatEnvelope.semantics as JsonObject;
    const responsesNode = isJsonObject((semantics as any).responses)
      ? ((semantics as any).responses as JsonObject)
      : undefined;
    const contextNode =
      responsesNode && isJsonObject(responsesNode.context)
        ? (responsesNode.context as JsonObject)
        : undefined;
    return contextNode ? jsonClone(contextNode) : undefined;
  })();
  logHubStageTiming(
    requestId,
    "req_inbound.stage2_operation_table_inbound",
    "start",
  );
  const operationTableStart = Date.now();
  applyHubOperationTableInbound({
    formatEnvelope: options.formatEnvelope,
    chatEnvelope,
    adapterContext: options.adapterContext,
  });
  logHubStageTiming(
    requestId,
    "req_inbound.stage2_operation_table_inbound",
    "completed",
    {
      elapsedMs: Date.now() - operationTableStart,
      forceLog: forceDetailLog,
    },
  );
  // Semantic Gate (request): before entering chat_process, lift any mappable protocol semantics
  // into ChatEnvelope.semantics. Do not persist these in metadata.
  logHubStageTiming(requestId, "req_inbound.stage2_semantic_lift", "start");
  const semanticLiftStart = Date.now();
  liftReqInboundSemantics({
    chatEnvelope,
    formatEnvelope: options.formatEnvelope,
    adapterContext: options.adapterContext,
    responsesResume: options.responsesResume,
  });
  logHubStageTiming(
    requestId,
    "req_inbound.stage2_semantic_lift",
    "completed",
    {
      elapsedMs: Date.now() - semanticLiftStart,
      forceLog: forceDetailLog,
    },
  );
  if (preservedResponsesContext) {
    const currentSemantics = chatEnvelope.semantics;
    if (!currentSemantics || typeof currentSemantics !== "object") {
      chatEnvelope.semantics = {
        responses: { context: jsonClone(preservedResponsesContext) },
      } as JsonObject;
    } else {
      const semantics = currentSemantics as JsonObject;
      const responsesNode = isJsonObject((semantics as any).responses)
        ? ((semantics as any).responses as JsonObject)
        : ({} as JsonObject);
      if (!isJsonObject(responsesNode.context)) {
        chatEnvelope.semantics = {
          ...semantics,
          responses: {
            ...responsesNode,
            context: jsonClone(preservedResponsesContext),
          },
        } as JsonObject;
      }
    }
  }
  logHubStageTiming(
    requestId,
    "req_inbound.stage2_validate_chat_envelope",
    "start",
  );
  const validateStart = Date.now();
  validateChatEnvelopeWithNative(chatEnvelope, {
    stage: "req_inbound",
    direction: "request",
  });
  logHubStageTiming(
    requestId,
    "req_inbound.stage2_validate_chat_envelope",
    "completed",
    {
      elapsedMs: Date.now() - validateStart,
      forceLog: forceDetailLog,
    },
  );
  recordStage(
    options.stageRecorder,
    "chat_process.req.stage2.semantic_map",
    chatEnvelope,
  );
  logHubStageTiming(requestId, "req_inbound.stage2_to_standardized", "start");
  const stdStart = Date.now();
  const standardizedRequest = chatEnvelopeToStandardizedWithNative({
    chatEnvelope: chatEnvelope as unknown as Record<string, unknown>,
    adapterContext: options.adapterContext as unknown as Record<
      string,
      unknown
    >,
    endpoint: options.adapterContext.entryEndpoint,
    requestId: options.adapterContext.requestId,
  }) as unknown as StandardizedRequest;
  logHubStageTiming(
    requestId,
    "req_inbound.stage2_to_standardized",
    "completed",
    { elapsedMs: Date.now() - stdStart },
  );
  // Ensure responses semantics (context) survive into standardized request for VirtualRouter parsing.
  if (chatEnvelope.semantics && typeof chatEnvelope.semantics === "object") {
    const envelopeSemantics = chatEnvelope.semantics as JsonObject;
    const existing = standardizedRequest.semantics;
    if (!existing || typeof existing !== "object") {
      standardizedRequest.semantics = jsonClone(envelopeSemantics);
    } else {
      const existingObj = existing as JsonObject;
      const envelopeResponses = isJsonObject(
        (envelopeSemantics as any).responses,
      )
        ? ((envelopeSemantics as any).responses as JsonObject)
        : undefined;
      const envelopeContext =
        envelopeResponses && isJsonObject(envelopeResponses.context)
          ? (envelopeResponses.context as JsonObject)
          : undefined;
      if (envelopeContext) {
        const nextResponses = {
          ...(isJsonObject((existingObj as any).responses)
            ? ((existingObj as any).responses as JsonObject)
            : {}),
          context: jsonClone(envelopeContext),
        };
        standardizedRequest.semantics = {
          ...existingObj,
          responses: nextResponses,
        } as JsonObject;
      }
    }
  }
  return {
    chatEnvelope,
    standardizedRequest,
    ...(preservedResponsesContext
      ? { responsesContext: preservedResponsesContext }
      : {}),
  };
}
