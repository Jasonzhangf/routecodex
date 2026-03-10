import type { AdapterContext } from '../../types/chat-envelope.js';
import type { JsonObject } from '../../types/json.js';
import type { CompatApplicationResult } from './compat-types.js';
import {
  runReqOutboundStage3CompatWithNative,
  runRespInboundStage3CompatWithNative
} from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';
import { buildNativeReqOutboundCompatAdapterContext } from './native-adapter-context.js';

const RATE_LIMIT_ERROR = 'ERR_COMPAT_RATE_LIMIT_DETECTED';

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

export function runRequestCompatPipeline(
  profileId: string | undefined,
  payload: JsonObject,
  options?: { adapterContext?: AdapterContext }
): CompatApplicationResult {
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

export function runResponseCompatPipeline(
  profileId: string | undefined,
  payload: JsonObject,
  options?: { adapterContext?: AdapterContext }
): CompatApplicationResult {
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
