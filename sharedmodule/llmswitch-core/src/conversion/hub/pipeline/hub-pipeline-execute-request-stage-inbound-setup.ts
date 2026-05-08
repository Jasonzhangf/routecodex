import type { JsonObject } from "../types/json.js";
import type { HubPipelineConfig, NormalizedRequest } from "./hub-pipeline.js";
import { buildAdapterContextFromNormalized } from "./hub-pipeline-adapter-context.js";
import {
} from "./hub-pipeline-chat-process-request-utils.js";
import {
  createChatProcessSnapshotRecorder,
  prepareChatProcessRuntimeMetadata,
} from "./hub-pipeline-chat-process-entry-blocks.js";
import {
  applyApplyPatchToolModeRuntimeHint,
  applyCompactionRuntimeHint,
} from "./hub-pipeline-execute-request-stage-inbound-runtime-hints-blocks.js";

export function applyInboundRuntimeHints(
  normalized: NormalizedRequest,
  rawRequest: JsonObject,
): void {
  try {
    applyApplyPatchToolModeRuntimeHint(normalized, rawRequest);
  } catch (toolScanError) {
    console.warn(
      `[hub-pipeline] applyPatchToolMode scan failed (non-blocking): ${
        toolScanError instanceof Error
          ? toolScanError.message
          : String(toolScanError)
      }`,
    );
  }
  applyCompactionRuntimeHint(normalized, rawRequest);
}

export function prepareInboundExecutionContext(args: {
  normalized: NormalizedRequest;
  config: HubPipelineConfig;
}): {
  effectivePolicy: HubPipelineConfig["policy"];
  shadowCompareBaselineMode: NormalizedRequest["shadowCompare"] extends {
    baselineMode: infer T;
  }
    ? T
    : never;
  inboundAdapterContext: ReturnType<typeof buildAdapterContextFromNormalized>;
  inboundRecorder: ReturnType<typeof createChatProcessSnapshotRecorder>;
  inboundStart: number;
} {
  const inboundAdapterContext = buildAdapterContextFromNormalized(args.normalized);
  return {
    effectivePolicy: args.normalized.policyOverride ?? args.config.policy,
    shadowCompareBaselineMode: args.normalized.shadowCompare?.baselineMode,
    inboundAdapterContext,
    inboundRecorder: createChatProcessSnapshotRecorder({
      normalized: args.normalized,
      adapterContext: inboundAdapterContext,
      warningLabel: "Inbound snapshot recorder creation",
    }),
    inboundStart: Date.now(),
  };
}

export function prepareInboundProcessMetadata(args: {
  normalized: NormalizedRequest;
  config: HubPipelineConfig;
}): Record<string, unknown> {
  return prepareChatProcessRuntimeMetadata(args);
}
