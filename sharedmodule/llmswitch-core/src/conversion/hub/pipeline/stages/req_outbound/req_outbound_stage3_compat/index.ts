import type { AdapterContext } from '../../../../types/chat-envelope.js';
import type { StageRecorder } from '../../../../format-adapters/index.js';
import type { JsonObject } from '../../../../types/json.js';
import { buildNativeReqOutboundCompatAdapterContext } from '../../../compat/native-adapter-context.js';
import { resolveCompatProfileWithNative } from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js';
import {
  runReqOutboundStage3CompatWithNative,
  runRespInboundStage3CompatWithNative
} from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';

export type ProviderPayload = JsonObject;
const RATE_LIMIT_ERROR = 'ERR_COMPAT_RATE_LIMIT_DETECTED';

function pickCompatProfile(adapterContext: AdapterContext): string | undefined {
  const candidate = (adapterContext as unknown as { compatibilityProfile?: unknown }).compatibilityProfile;
  const explicit = typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
  return resolveCompatProfileWithNative(adapterContext, explicit);
}

export async function runReqOutboundStage3Compat(options: {
  payload: ProviderPayload;
  adapterContext: AdapterContext;
  stageRecorder?: StageRecorder;
}): Promise<ProviderPayload> {
  const profile = pickCompatProfile(options.adapterContext);
  const nativeCompat = runReqOutboundStage3CompatWithNative(
    {
      payload: options.payload,
      adapterContext: buildNativeReqOutboundCompatAdapterContext(options.adapterContext),
      explicitProfile: profile
    }
  );
  const effectiveProfile = nativeCompat.appliedProfile ?? profile;
  const appliedProfile = nativeCompat.appliedProfile;
  options.stageRecorder?.record('chat_process.req.stage8.outbound.compat', {
    applied: Boolean(appliedProfile),
    profile: appliedProfile || effectiveProfile || 'passthrough'
  });
  return nativeCompat.payload;
}

export function runRespInboundStageCompatResponse(options: {
  payload: ProviderPayload;
  adapterContext: AdapterContext;
  stageRecorder?: StageRecorder;
}): ProviderPayload {
  const profile = pickCompatProfile(options.adapterContext);
  const nativeCompat = runRespInboundStage3CompatWithNative({
    payload: options.payload,
    adapterContext: buildNativeReqOutboundCompatAdapterContext(options.adapterContext),
    explicitProfile: profile
  });
  const effectiveProfile = nativeCompat.appliedProfile ?? profile;
  const appliedProfile = nativeCompat.appliedProfile;
  if (nativeCompat.nativeApplied === true && nativeCompat.rateLimitDetected === true) {
    const err = new Error('Provider returned rate limit notice');
    (err as Error & { code?: string; statusCode?: number }).code = RATE_LIMIT_ERROR;
    (err as Error & { code?: string; statusCode?: number }).statusCode = 429;
    throw err;
  }
  options.stageRecorder?.record('chat_process.resp.stage3.compat', {
    applied: Boolean(appliedProfile),
    profile: appliedProfile || effectiveProfile || 'passthrough'
  });
  return nativeCompat.payload;
}
