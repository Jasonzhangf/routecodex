#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const verifier = resolve(repo, 'scripts/architecture/verify-v3-gemini-relay-runtime-integration.mjs');
const runtime = 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs';
const server = 'v3/crates/routecodex-v3-server/src/lib.rs';
const entryBindingManifest = 'docs/architecture/manifests/v3.entry_protocol_endpoint_binding.mainline.yml';
const virtualRouter = 'v3/crates/routecodex-v3-virtual-router/src/lib.rs';
const cases = [
  ['missing Req06', runtime, '    trace.push("V3HubReqTarget06Resolved");', '', /V3HubReqTarget06Resolved/],
  ['transport skipped', runtime, 'transport.send(transport_request).await', 'Ok::<_, V3ProviderError>(unreachable!())', /transport\.send/],
  ['fallback added', runtime, 'let mut trace = Vec::with_capacity(15);', 'let fallback = true; let mut trace = Vec::with_capacity(15);', /fallback/],
  ['Responses Direct re-entry', runtime, 'let mut trace = Vec::with_capacity(15);', 'let _ = "ResponsesDirect11Policy"; let mut trace = Vec::with_capacity(15);', /ResponsesDirect/],
  ['dynamic hooks', runtime, 'compile_v3_hub_v1_static_registry()', 'std::fs::read_dir(".").unwrap(); compile_v3_hub_v1_static_registry()', /read_dir|dynamic/],
  ['raw SSE materialization', runtime, 'sse_transport_core::SseIncrementalDecoder::new(', 'let sse_frames = Vec::new(); sse_transport_core::SseIncrementalDecoder::new(', /sse_frames/],
  ['Server Gemini semantic parse', server, 'fn gemini_relay_output_response(output: V3GeminiRelayRuntimeOutput) -> Response<Body> {', 'fn gemini_relay_output_response(output: V3GeminiRelayRuntimeOutput) -> Response<Body> {\n    let _semantic_parse = "finishReason";', /finishReason/],
  ['binding regresses to pending', entryBindingManifest, '    execution_mode: relay\n    implementation_status: implemented\n    owner_feature_id: v3.gemini_relay_runtime_integration\n    runtime_owner_symbol: execute_v3_gemini_relay_runtime_with_default_transport\n    runtime_owner_path: v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs', '    execution_mode: pending_not_implemented\n    implementation_status: pending_not_implemented\n    owner_feature_id: v3.entry_protocol_endpoint_binding\n    pending_owner: execute_v3_foundation_pending_runtime', /execution_mode: relay|execute_v3_gemini_relay_runtime_with_default_transport/],
  ['dynamic Gemini endpoint classification removed', virtualRouter, 'if endpoint.starts_with("/v1beta/models/") && endpoint.ends_with("/generateContent") {', 'if endpoint == "/v1beta/models" {', /starts_with\("\/v1beta\/models\/"\)|ends_with\("\/generateContent"\)/],
  ['internal carrier leak', runtime, 'use super::*;', 'const INTERNAL_CARRIER: &str = "metadata_center";\nuse super::*;', /metadata_center/],
];
const copied = [
  runtime,
  'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
  'v3/crates/routecodex-v3-runtime/tests/gemini_relay_runtime_integration.rs',
  'docs/goals/v3-gemini-relay-runtime-integration-test-design.md',
  server,
  'v3/crates/routecodex-v3-server/tests/gemini_relay_controlled.rs',
  'v3/crates/routecodex-v3-config/src/validate.rs',
  'v3/crates/routecodex-v3-config/tests/config_v3_contract.rs',
  virtualRouter,
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'docs/architecture/manifests/v3.gemini_relay.controlled_runtime.mainline.yml',
  entryBindingManifest,
  'docs/architecture/wiki/v3-gemini-relay-controlled-runtime.md',
  'docs/architecture/wiki/html/v3-gemini-relay-controlled-runtime.html',
  'package.json',
];
const failures = [];
for (const [name, file, from, to, diagnostic] of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-gemini-relay-red-'));
  try {
    for (const path of copied) cpSync(resolve(repo, path), resolve(root, path), { recursive: true });
    const target = resolve(root, file);
    const source = readFileSync(target, 'utf8');
    if (!source.includes(from)) throw new Error(name + ': mutation source missing');
    writeFileSync(target, source.replace(from, to));
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = (result.stdout || '') + '\n' + (result.stderr || '');
    if (result.status === 0) failures.push(name + ': verifier unexpectedly passed');
    else if (!diagnostic.test(output)) failures.push(name + ': wrong diagnostic: ' + output.slice(-700));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
if (failures.length) {
  console.error('[test:v3-gemini-relay-runtime-integration-red-fixtures] failed');
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}
console.log('[test:v3-gemini-relay-runtime-integration-red-fixtures] ok (' + cases.length + ' forbidden mutations rejected)');
