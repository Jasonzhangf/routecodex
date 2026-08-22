import { createRequire } from 'node:module';
import path from 'node:path';

// feature_id: sse.public_ts_lib_surface
// feature_id: sse.runtime_rust_dispatch
// canonical_builders: sse_public_ts_lib_surface_deleted_contract
// canonical_builders: build_sse_frames_from_json_json, build_json_from_sse_json
export const sse_public_ts_lib_surface_deleted_contract = true;

const nodeRequire = createRequire(import.meta.url);
let nativeBinding = null;

function candidateNativePaths() {
  return [
    path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node'),
  ];
}

function getNativeBinding() {
  if (nativeBinding) return nativeBinding;
  const failures = [];
  for (const candidate of candidateNativePaths()) {
    try {
      nativeBinding = nodeRequire(candidate);
      if (nativeBinding && typeof nativeBinding === 'object') {
        return nativeBinding;
      }
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`router_hotpath_napi native binding not found:\n${failures.join('\n')}`);
}

function nativeFn(name) {
  const fn = getNativeBinding()[name];
  if (typeof fn !== 'function') {
    throw new Error(`${name} native export is required`);
  }
  return fn;
}

function parseNativeRecord(raw, capability) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`${capability} returned invalid payload`);
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${capability} returned non-object payload`);
  }
  return parsed;
}

export async function collectSseBodyText(source) {
  const chunks = [];
  for await (const chunk of source) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
  }
  return chunks.join('');
}

export function buildJsonFromSseWithNative(input) {
  return parseNativeRecord(nativeFn('buildJsonFromSseJson')(JSON.stringify({
    protocol: input.protocol,
    body_text: input.bodyText,
    request_id: input.requestId,
    model: input.model,
    config: input.config ?? {},
  })), 'buildJsonFromSseJson');
}

export function buildSseFramesFromJsonWithNative(input) {
  const parsed = parseNativeRecord(nativeFn('buildSseFramesFromJsonJson')(JSON.stringify({
    protocol: input.protocol,
    response: input.response,
    request_id: input.requestId,
    model: input.model,
    config: input.config ?? {},
  })), 'buildSseFramesFromJsonJson');
  if (!Array.isArray(parsed.frames) || parsed.frames.some((frame) => typeof frame !== 'string')) {
    throw new Error('buildSseFramesFromJsonJson returned invalid frames');
  }
  return parsed;
}
