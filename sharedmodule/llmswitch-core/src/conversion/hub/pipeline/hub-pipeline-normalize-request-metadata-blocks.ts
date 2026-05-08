import type { StageRecorder } from "../format-adapters/index.js";
import type { HubPolicyConfig } from "../policy/policy-engine.js";
import {
  resolveHubPolicyOverrideFromMetadataWithNative,
  resolveHubShadowCompareConfigWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import type {
  HubShadowCompareRequestConfig,
  NormalizedRequest,
} from "./hub-pipeline.js";

export function extractRequestMetadataOptions(metadataRecord: Record<string, unknown>): {
  policyOverride?: HubPolicyConfig;
  shadowCompare?: HubShadowCompareRequestConfig;
  disableSnapshots: boolean;
  hubEntryMode?: NormalizedRequest["hubEntryMode"];
  externalStageRecorder?: StageRecorder;
} {
  const policyOverride = resolveHubPolicyOverrideFromMetadataWithNative(
    metadataRecord,
  ) as HubPolicyConfig | undefined;
  delete metadataRecord.__hubPolicyOverride;

  const shadowCompare = resolveHubShadowCompareConfigWithNative(
    metadataRecord,
  ) as HubShadowCompareRequestConfig | undefined;
  delete metadataRecord.__hubShadowCompare;

  const disableSnapshots = metadataRecord.__disableHubSnapshots === true;
  delete metadataRecord.__disableHubSnapshots;

  const hubEntryRaw =
    typeof metadataRecord.__hubEntry === "string"
      ? String(metadataRecord.__hubEntry).trim().toLowerCase()
      : "";
  const hubEntryMode: NormalizedRequest["hubEntryMode"] =
    hubEntryRaw === "chat_process" ||
    hubEntryRaw === "chat-process" ||
    hubEntryRaw === "chatprocess"
      ? "chat_process"
      : undefined;
  delete metadataRecord.__hubEntry;

  const externalStageRecorder =
    metadataRecord.__hubStageRecorder &&
    typeof (metadataRecord.__hubStageRecorder as StageRecorder).record === "function"
      ? (metadataRecord.__hubStageRecorder as StageRecorder)
      : undefined;
  delete metadataRecord.__hubStageRecorder;

  return {
    policyOverride: policyOverride ?? undefined,
    shadowCompare: shadowCompare ?? undefined,
    disableSnapshots,
    ...(hubEntryMode ? { hubEntryMode } : {}),
    ...(externalStageRecorder ? { externalStageRecorder } : {}),
  };
}
