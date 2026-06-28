import type { JsonObject } from '../../types/json.js';
import type { AdapterContext } from '../../types/chat-envelope.js';
import type { CompatApplicationResult } from './compat-types.js';
import {
  runReqOutboundStage3CompatWithNative,
  runRespInboundStage3CompatWithNative
} from '../../../../native/router-hotpath/native-hub-pipeline-req-outbound-semantics.js';
import {
  normalizeProviderProtocolTokenWithNative
} from '../../../../native/router-hotpath/native-hub-pipeline-req-inbound-semantics.js';
import { buildNativeReqOutboundCompatAdapterContext } from './native-adapter-context.js';

// feature_id: responses.request_compat_normalization
// feature_id: responses.function_tool_normalization
// feature_id: responses.tool_parameters_normalization
// feature_id: responses.instructions_to_input_normalization
// Rust canonical builders: normalize_responses_tool_parameters / normalize_responses_function_tools / apply_responses_instructions_to_input / apply_responses_crs_request_compat
// feature_id: responses.crs_request_compat
// Rust aggregate builder: run_req_outbound_stage3_compat_json

function assertCompatNativeBoundary(): void {
  normalizeProviderProtocolTokenWithNative('openai-responses');
}

function normalizeProfileId(profileId: string | undefined): string | undefined {
  if (typeof profileId !== 'string') {
    return undefined;
  }
  const trimmed = profileId.trim();
  return trimmed.length ? trimmed : undefined;
}

function toCompatResult(payload: JsonObject, appliedProfile?: string): CompatApplicationResult {
  if (typeof appliedProfile === 'string' && appliedProfile.trim().length) {
    return { payload, appliedProfile: appliedProfile.trim() };
  }
  return { payload };
}

export function applyRequestCompat(
  profileId: string | undefined,
  payload: JsonObject,
  options?: { adapterContext?: AdapterContext }
): CompatApplicationResult {
  assertCompatNativeBoundary();
  const explicitProfile = normalizeProfileId(profileId);

  const nativeCompat = runReqOutboundStage3CompatWithNative({
    payload,
    explicitProfile,
    adapterContext: buildNativeReqOutboundCompatAdapterContext(options?.adapterContext)
  });

  return toCompatResult(nativeCompat.payload, nativeCompat.appliedProfile);
}

export function applyResponseCompat(
  profileId: string | undefined,
  payload: JsonObject,
  options?: { adapterContext?: AdapterContext }
): CompatApplicationResult {
  assertCompatNativeBoundary();
  const explicitProfile = normalizeProfileId(profileId);

  const nativeCompat = runRespInboundStage3CompatWithNative({
    payload,
    explicitProfile,
    adapterContext: buildNativeReqOutboundCompatAdapterContext(options?.adapterContext)
  });

  return toCompatResult(nativeCompat.payload, nativeCompat.appliedProfile);
}
