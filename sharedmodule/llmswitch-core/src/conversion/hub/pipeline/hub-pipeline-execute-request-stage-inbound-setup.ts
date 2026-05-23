import type { JsonObject } from "../types/json.js";
import type { HubPipelineConfig, NormalizedRequest } from "./hub-pipeline.js";
import { buildAdapterContextFromNormalized } from "./hub-pipeline-adapter-context.js";
import {
  createChatProcessSnapshotRecorder,
  prepareChatProcessRuntimeMetadata,
} from "./hub-pipeline-chat-process-entry-blocks.js";
import { isCompactionRequest } from "../../compaction-detect.js";
import { ensureRuntimeMetadata } from "../../runtime-metadata.js";

export function applyInboundRuntimeHints(
  normalized: NormalizedRequest,
  rawRequest: JsonObject,
): void {
  if (!isCompactionRequest(rawRequest)) {
    return;
  }
  normalized.metadata = normalized.metadata || {};
  const rt = ensureRuntimeMetadata(
    normalized.metadata as Record<string, unknown>,
  );
  (rt as Record<string, unknown>).compactionRequest = true;
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
