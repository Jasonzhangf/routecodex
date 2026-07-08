import type { AdapterContext } from '../../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import { readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter } from '../../../sharedmodule/llmswitch-core/src/conversion/hub/metadata-center-runtime-control-writer.js';
import {
  buildNativeReqOutboundCompatAdapterContextWithNative,
  runReqOutboundStage3CompatWithNative,
  runRespInboundStage3CompatWithNative,
} from '../../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-outbound-semantics.js';
import { normalizeProviderProtocolTokenWithNative } from '../../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-inbound-semantics.js';

// Native evidence anchors: run_req_outbound_stage3_compat_json,
// normalize_responses_function_tools, normalize_responses_tool_parameters,
// apply_responses_instructions_to_input, apply_responses_crs_request_compat.

export interface CompatApplicationResult {
  payload: JsonObject;
  appliedProfile?: string;
}

function normalizeProfileId(profileId: string | undefined): string | undefined {
  if (typeof profileId !== 'string') return undefined;
  const trimmed = profileId.trim();
  return trimmed.length ? trimmed : undefined;
}

function toCompatResult(payload: JsonObject, appliedProfile?: string): CompatApplicationResult {
  if (typeof appliedProfile === 'string' && appliedProfile.trim().length) {
    return { payload, appliedProfile: appliedProfile.trim() };
  }
  return { payload };
}

export function buildNativeReqOutboundCompatAdapterContextDirectNative(adapterContext?: AdapterContext) {
  const row = (adapterContext ?? {}) as Record<string, unknown>;
  const metadataCenterSnapshot =
    readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter(row)?.metadataCenterSnapshot;
  return buildNativeReqOutboundCompatAdapterContextWithNative({
    metadataCenterSnapshot: metadataCenterSnapshot ?? null,
  });
}

export function applyRequestCompatDirectNative(
  profileId: string | undefined,
  payload: JsonObject,
  options?: { adapterContext?: AdapterContext },
): CompatApplicationResult {
  normalizeProviderProtocolTokenWithNative('openai-responses');
  const nativeCompat = runReqOutboundStage3CompatWithNative({
    payload,
    explicitProfile: normalizeProfileId(profileId),
    adapterContext: buildNativeReqOutboundCompatAdapterContextDirectNative(options?.adapterContext),
  });
  return toCompatResult(nativeCompat.payload, nativeCompat.appliedProfile);
}

export function applyResponseCompatDirectNative(
  profileId: string | undefined,
  payload: JsonObject,
  options?: { adapterContext?: AdapterContext },
): CompatApplicationResult {
  normalizeProviderProtocolTokenWithNative('openai-responses');
  const nativeCompat = runRespInboundStage3CompatWithNative({
    payload,
    explicitProfile: normalizeProfileId(profileId),
    adapterContext: buildNativeReqOutboundCompatAdapterContextDirectNative(options?.adapterContext),
  });
  return toCompatResult(nativeCompat.payload, nativeCompat.appliedProfile);
}
