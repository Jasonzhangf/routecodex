import type { JsonObject } from "../types/json.js";
import type { StandardizedRequest } from "../types/standardized.js";
import type { HubPipelineConfig, NormalizedRequest } from "./hub-pipeline.js";
import { isCompactionRequest } from "../../compaction-detect.js";
import {
  resolveApplyPatchToolModeFromEnvWithNative,
  resolveApplyPatchToolModeFromToolsWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import { ensureRuntimeMetadata } from "../../runtime-metadata.js";
import { buildAdapterContextFromNormalized } from "./hub-pipeline-adapter-context.js";
import {
} from "./hub-pipeline-chat-process-request-utils.js";
import {
  createChatProcessSnapshotRecorder,
  prepareChatProcessRuntimeMetadata,
} from "./hub-pipeline-chat-process-entry-blocks.js";
import { finalizeWorkingRequestForOutbound } from "./hub-pipeline-working-request-blocks.js";

type ApplyPatchToolMode = "schema" | "freeform";

export function applyInboundRuntimeHints(
  normalized: NormalizedRequest,
  rawRequest: JsonObject,
): void {
  try {
    const toolsRaw = Array.isArray((rawRequest as any)?.tools)
      ? ((rawRequest as any).tools as unknown[])
      : null;
    const applyPatchToolMode =
      (resolveApplyPatchToolModeFromEnvWithNative() as
        | ApplyPatchToolMode
        | undefined) ??
      (resolveApplyPatchToolModeFromToolsWithNative(toolsRaw) as
        | ApplyPatchToolMode
        | undefined);
    if (applyPatchToolMode) {
      normalized.metadata = normalized.metadata || {};
      const rt = ensureRuntimeMetadata(
        normalized.metadata as Record<string, unknown>,
      );
      (rt as Record<string, unknown>).applyPatchToolMode = applyPatchToolMode;
    }
  } catch (toolScanError) {
    console.warn(
      `[hub-pipeline] applyPatchToolMode scan failed (non-blocking): ${
        toolScanError instanceof Error
          ? toolScanError.message
          : String(toolScanError)
      }`,
    );
  }

  if (isCompactionRequest(rawRequest)) {
    normalized.metadata = normalized.metadata || {};
    const rt = ensureRuntimeMetadata(
      normalized.metadata as Record<string, unknown>,
    );
    (rt as Record<string, unknown>).compactionRequest = true;
  }
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

export function finalizeInboundWorkingRequest(
  workingRequest: Record<string, unknown>,
  normalized: NormalizedRequest,
): {
  workingRequest: StandardizedRequest;
  hasImageAttachment: boolean;
  serverToolRequired: boolean;
} {
  const { workingRequest: synced, hasImageAttachment, serverToolRequired } =
    finalizeWorkingRequestForOutbound({
      request: workingRequest,
      normalized,
    });
  return {
    workingRequest: synced as StandardizedRequest,
    hasImageAttachment,
    serverToolRequired,
  };
}
