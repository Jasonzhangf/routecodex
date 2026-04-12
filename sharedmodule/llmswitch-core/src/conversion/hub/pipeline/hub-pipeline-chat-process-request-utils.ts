import type { AdapterContext } from "../types/chat-envelope.js";
import type { JsonObject } from "../types/json.js";
import { jsonClone } from "../types/json.js";
import type {
  ProcessedRequest,
  StandardizedMessage,
  StandardizedParameters,
  StandardizedRequest,
  StandardizedTool
} from "../types/standardized.js";
import type { NormalizedRequest } from "./hub-pipeline.js";
import {
  containsImageAttachment,
  repairIncompleteToolCalls,
  stripHistoricalImageAttachments,
  stripHistoricalVisualToolOutputs,
} from "../process/chat-process-media.js";
import { buildPassthroughAuditWithNative, readResponsesResumeFromRequestSemanticsWithNative, resolveActiveProcessModeWithNative } from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import { readRuntimeMetadata } from "../../runtime-metadata.js";
import { computeRequestTokens } from "../../../router/virtual-router/token-estimator.js";
import { estimateSessionBoundTokens } from "../process/chat-process-session-usage.js";
import {
  isHeavyInputFastpathEnabled,
  markHeavyInputFastpath,
  resolveHeavyInputTokenThreshold,
  roughEstimateInputTokensFromRequest,
} from "./hub-pipeline-heavy-input-fastpath.js";
import {
  syncReasoningStopModeFromRequest,
  type ReasoningStopMode
} from "../../../servertool/handlers/reasoning-stop-state.js";

const REASONING_STOP_TOOL_DEF: StandardizedTool = {
  type: 'function',
  function: {
    name: 'reasoning.stop',
    description:
      'Structured stop self-check gate. Stop is allowed only when either: (A) task is completed with completion_evidence; or (B) all feasible attempts are exhausted and blocked, with cannot_complete_reason + blocking_evidence + attempts_exhausted=true. Required: task_goal, is_completed. If not completed but a concrete next action exists, fill next_step and continue instead of stopping.',
    parameters: {
      type: 'object',
      properties: {
        task_goal: { type: 'string' },
        is_completed: { type: 'boolean' },
        completion_evidence: { type: 'string' },
        cannot_complete_reason: { type: 'string' },
        blocking_evidence: { type: 'string' },
        attempts_exhausted: { type: 'boolean' },
        next_step: { type: 'string' }
      },
      required: ['task_goal', 'is_completed'],
      additionalProperties: false
    }
  }
};

function hasReasoningStopTool(tools: StandardizedTool[] | undefined): boolean {
  return Boolean(
    Array.isArray(tools) &&
      tools.some((tool) => {
        const name =
          tool &&
          typeof tool === 'object' &&
          tool.function &&
          typeof tool.function === 'object' &&
          typeof tool.function.name === 'string'
            ? tool.function.name.trim().toLowerCase()
            : '';
        return name === 'reasoning.stop';
      })
  );
}

function buildCapturedChatRequestFromStandardized(request: StandardizedRequest): JsonObject {
  const out: JsonObject = {
    model: request.model,
    messages: jsonClone(request.messages as unknown as JsonObject[]) as unknown as JsonObject
  };
  if (Array.isArray(request.tools)) {
    out.tools = jsonClone(request.tools as unknown as JsonObject[]) as unknown as JsonObject;
  }
  if (request.parameters && typeof request.parameters === 'object') {
    out.parameters = jsonClone(request.parameters as unknown as JsonObject);
  }
  return out;
}

export function sanitizeStandardizedRequestMessages(
  standardizedRequest: StandardizedRequest,
): StandardizedRequest {
  return {
    ...standardizedRequest,
    messages: repairIncompleteToolCalls(
      stripHistoricalVisualToolOutputs(
        stripHistoricalImageAttachments(standardizedRequest.messages),
      ),
    ),
  };
}

export function propagateApplyPatchToolModeToRequestMetadata(
  normalizedMetadata: Record<string, unknown> | undefined,
  standardizedRequest: StandardizedRequest,
): void {
  try {
    const rt = readRuntimeMetadata(
      (normalizedMetadata ?? {}) as Record<string, unknown>,
    );
    const mode = String((rt as any)?.applyPatchToolMode || "")
      .trim()
      .toLowerCase();
    if (mode === "freeform" || mode === "schema") {
      (
        standardizedRequest.metadata as Record<string, unknown>
      ).applyPatchToolMode = mode;
    }
  } catch {
    // best-effort: do not block request handling due to metadata propagation failures
  }
}

export function resolveActiveProcessModeAndAudit(args: {
  normalized: Pick<NormalizedRequest, "processMode" | "providerProtocol">;
  requestMessages: StandardizedRequest["messages"];
  rawPayload: Record<string, unknown>;
}): {
  activeProcessMode: "chat" | "passthrough";
  passthroughAudit?: Record<string, unknown>;
} {
  const { normalized, requestMessages, rawPayload } = args;
  const activeProcessMode = resolveActiveProcessModeWithNative(
    normalized.processMode,
    requestMessages,
  );
  if (activeProcessMode !== normalized.processMode) {
    normalized.processMode = activeProcessMode;
  }
  const passthroughAudit =
    activeProcessMode === "passthrough"
      ? buildPassthroughAuditWithNative(rawPayload, normalized.providerProtocol)
      : undefined;
  return { activeProcessMode, passthroughAudit };
}

export function estimateInputTokensForWorkingRequest(args: {
  workingRequest: StandardizedRequest | ProcessedRequest;
  normalizedMetadata: Record<string, unknown> | undefined;
}): void {
  const { workingRequest, normalizedMetadata } = args;
  try {
    const fastpathEnabled = isHeavyInputFastpathEnabled();
    const threshold = resolveHeavyInputTokenThreshold();
    if (fastpathEnabled && threshold > 0) {
      const roughEstimate = roughEstimateInputTokensFromRequest(workingRequest);
      if (roughEstimate >= threshold) {
        if (normalizedMetadata && typeof normalizedMetadata === "object") {
          normalizedMetadata.estimatedInputTokens = roughEstimate;
          markHeavyInputFastpath({
            metadata: normalizedMetadata,
            estimatedInputTokens: roughEstimate,
            reason: "rough_estimate",
          });
        }
        return;
      }
    }

    const estimatedTokens =
      estimateSessionBoundTokens(
        workingRequest,
        normalizedMetadata as Record<string, unknown> | undefined,
      ) ?? computeRequestTokens(workingRequest, "");
    if (
      typeof estimatedTokens === "number" &&
      Number.isFinite(estimatedTokens) &&
      estimatedTokens > 0
    ) {
      if (normalizedMetadata && typeof normalizedMetadata === "object") {
        normalizedMetadata.estimatedInputTokens = estimatedTokens;
        if (fastpathEnabled && estimatedTokens >= threshold) {
          markHeavyInputFastpath({
            metadata: normalizedMetadata,
            estimatedInputTokens: estimatedTokens,
            reason: "full_estimate",
          });
        }
      }
    }
  } catch {
    // 估算失败不应影响主流程
  }
}

export function deriveWorkingRequestFlags(
  workingRequest: StandardizedRequest | ProcessedRequest,
): {
  responsesResume?: Record<string, unknown>;
  hasImageAttachment: boolean;
  serverToolRequired: boolean;
} {
  const responsesResume =
    readResponsesResumeFromRequestSemanticsWithNative(workingRequest);
  const stdMetadata = (
    workingRequest as StandardizedRequest | ProcessedRequest | undefined
  )?.metadata as Record<string, unknown> | undefined;
  const hasImageAttachment = containsImageAttachment(
    (workingRequest.messages ?? []) as StandardizedRequest["messages"],
  );
  const serverToolRequired =
    stdMetadata?.webSearchEnabled === true ||
    stdMetadata?.serverToolRequired === true;
  return {
    responsesResume,
    hasImageAttachment,
    serverToolRequired,
  };
}

export function prepareReasoningStopRequestTooling(args: {
  request: StandardizedRequest;
  adapterContext: AdapterContext;
}): ReasoningStopMode {
  const captured = buildCapturedChatRequestFromStandardized(args.request);
  (args.adapterContext as Record<string, unknown>).capturedChatRequest = captured;
  const mode = syncReasoningStopModeFromRequest(args.adapterContext, 'on');
  const capturedMessages = (captured as Record<string, unknown>).messages;
  const strippedMessages = Array.isArray(capturedMessages)
    ? (jsonClone(capturedMessages as unknown as JsonObject[]) as unknown as StandardizedMessage[])
    : undefined;
  if (strippedMessages) {
    args.request.messages = strippedMessages;
  }
  if (mode === 'off') {
    return mode;
  }
  if (!hasReasoningStopTool(args.request.tools)) {
    const nextTools = Array.isArray(args.request.tools) ? [...args.request.tools] : [];
    nextTools.push(jsonClone(REASONING_STOP_TOOL_DEF as unknown as JsonObject) as unknown as StandardizedTool);
    args.request.tools = nextTools;
  }
  (captured as { messages?: StandardizedMessage[] }).messages = jsonClone(
    args.request.messages as unknown as JsonObject[]
  ) as unknown as StandardizedMessage[];
  (captured as { tools?: StandardizedTool[] }).tools = jsonClone(
    (args.request.tools ?? []) as unknown as JsonObject[]
  ) as unknown as StandardizedTool[];
  (captured as { parameters?: StandardizedParameters }).parameters = jsonClone(
    args.request.parameters as unknown as JsonObject
  ) as unknown as StandardizedParameters;
  return mode;
}
