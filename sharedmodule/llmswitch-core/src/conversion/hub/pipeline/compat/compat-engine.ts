import type { JsonObject } from '../../types/json.js';
import type { AdapterContext } from '../../types/chat-envelope.js';
import type { CompatApplicationResult } from './compat-types.js';
import {
  runReqOutboundStage3CompatWithNative,
  runRespInboundStage3CompatWithNative
} from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';
import {
  normalizeProviderProtocolTokenWithNative
} from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';
import { buildNativeReqOutboundCompatAdapterContext } from './native-adapter-context.js';

// feature_id: responses.request_compat_normalization
// feature_id: responses.function_tool_normalization
// feature_id: responses.tool_parameters_normalization
// feature_id: responses.instructions_to_input_normalization
// feature_id: responses.token_limit_field_normalization
// Rust canonical builders: normalize_responses_tool_parameters / normalize_responses_function_tools / apply_responses_instructions_to_input / apply_responses_token_limit_field_normalization / apply_responses_c4m_request_compat / apply_responses_crs_request_compat
// feature_id: responses.c4m_request_compat
// feature_id: responses.crs_request_compat
// Rust aggregate builder: run_req_outbound_stage3_compat_json

const RATE_LIMIT_ERROR = 'ERR_COMPAT_RATE_LIMIT_DETECTED';

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
  if (!explicitProfile) {
    return { payload };
  }

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
  if (!explicitProfile) {
    return { payload };
  }

  const nativeCompat = runRespInboundStage3CompatWithNative({
    payload,
    explicitProfile,
    adapterContext: buildNativeReqOutboundCompatAdapterContext(options?.adapterContext)
  });

  if (nativeCompat.nativeApplied === true && nativeCompat.rateLimitDetected === true) {
    const err = new Error('Provider returned rate limit notice');
    (err as Error & { code?: string; statusCode?: number }).code = RATE_LIMIT_ERROR;
    (err as Error & { code?: string; statusCode?: number }).statusCode = 429;
    throw err;
  }

  return toCompatResult(nativeCompat.payload, nativeCompat.appliedProfile);
}
