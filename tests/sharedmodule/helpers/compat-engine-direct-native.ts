import { readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter } from '../../../sharedmodule/llmswitch-core/src/conversion/hub/metadata-center-runtime-control-writer.js';
import { normalizeProviderProtocolTokenWithNative } from '../../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-inbound-semantics.js';
import path from 'node:path';
import { createRequire } from 'node:module';

// Native evidence anchors: run_req_outbound_stage3_compat_json,
// normalize_responses_function_tools, normalize_responses_tool_parameters,
// apply_responses_instructions_to_input, apply_responses_crs_request_compat.
// feature_id: responses.request_compat_normalization
// canonical_builders: run_req_outbound_stage3_compat_json

const nodeRequire = createRequire(import.meta.url);
const nativeBinding = nodeRequire(
  path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node')
) as Record<string, unknown>;

type AdapterContext = Record<string, unknown>;
type JsonObject = Record<string, unknown>;

function nativeFn(name: string): (...args: unknown[]) => unknown {
  const fn = nativeBinding[name];
  if (typeof fn !== 'function') {
    throw new Error(`${name} native export is required`);
  }
  return fn as (...args: unknown[]) => unknown;
}

function parseNativeRecord(raw: unknown, capability: string): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`${capability} returned invalid payload`);
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${capability} returned non-object payload`);
  }
  return parsed as Record<string, unknown>;
}

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
  return parseNativeRecord(
    nativeFn('buildNativeReqOutboundCompatAdapterContextJson')(JSON.stringify({
      metadataCenterSnapshot: metadataCenterSnapshot ?? null,
    })),
    'buildNativeReqOutboundCompatAdapterContextJson'
  );
}

export function applyRequestCompatDirectNative(
  profileId: string | undefined,
  payload: JsonObject,
  options?: { adapterContext?: AdapterContext },
): CompatApplicationResult {
  normalizeProviderProtocolTokenWithNative('openai-responses');
  const nativeCompat = parseNativeRecord(nativeFn('runReqOutboundStage3CompatJson')(JSON.stringify({
    payload,
    explicitProfile: normalizeProfileId(profileId),
    adapterContext: buildNativeReqOutboundCompatAdapterContextDirectNative(options?.adapterContext),
  })), 'runReqOutboundStage3CompatJson') as unknown as {
    payload: JsonObject;
    appliedProfile?: string;
  };
  return toCompatResult(nativeCompat.payload, nativeCompat.appliedProfile);
}

export function applyResponseCompatDirectNative(
  profileId: string | undefined,
  payload: JsonObject,
  options?: { adapterContext?: AdapterContext },
): CompatApplicationResult {
  normalizeProviderProtocolTokenWithNative('openai-responses');
  const nativeCompat = parseNativeRecord(nativeFn('runRespInboundStage3CompatJson')(JSON.stringify({
    payload,
    explicitProfile: normalizeProfileId(profileId),
    adapterContext: buildNativeReqOutboundCompatAdapterContextDirectNative(options?.adapterContext),
  })), 'runRespInboundStage3CompatJson') as unknown as {
    payload: JsonObject;
    appliedProfile?: string;
  };
  return toCompatResult(nativeCompat.payload, nativeCompat.appliedProfile);
}
