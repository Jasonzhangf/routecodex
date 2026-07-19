#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const verifier = resolve(repoRoot, 'scripts/architecture/verify-v3-relay-payload-copy-budget.mjs');
const fixtures = [
  {
    name: 'unbounded deep copy',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    marker: 'use serde_json::Value;',
    mutation: 'use serde_json::Value;\nfn forbidden_copy(payload: &Value) { payload.deep_clone(); }',
    diagnostic: /forbidden unbounded deep copy/,
  },
  {
    name: 'additional_tools lifted into top-level tools helper',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs',
    marker: 'fn inject_reasoning_stop_tool_into_additional_tools',
    mutation: 'fn lift_additional_tools_into_provider_tool_surface() {}\nfn inject_reasoning_stop_tool_into_additional_tools',
    diagnostic: /tool declaration shape rebuild helper/,
  },
  {
    name: 'JSON stringify parse roundtrip',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    marker: 'use serde_json::Value;',
    mutation: 'use serde_json::Value;\nfn forbidden_roundtrip(payload: &Value) { let encoded = serde_json::to_string(payload).unwrap(); let _: Value = serde_json::from_str(&encoded).unwrap(); }',
    diagnostic: /forbidden JSON serialization round-trip clone/,
  },
  {
    name: 'full SSE materialize',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
    marker: 'use serde_json::{json, Map, Value};',
    mutation: 'use serde_json::{json, Map, Value};\nfn forbidden_sse_materialize(sse_stream: impl Iterator<Item = Value>) { let _ = sse_stream.collect::<Vec<_>>(); }',
    diagnostic: /forbidden unowned full SSE materialization/,
  },
  {
    name: 'Relay SSE pass-through body kind resurrected',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
    marker: 'V3HubTransportIntent::Sse => V3HubResponseNormalizedKind::Sse',
    mutation: 'V3HubTransportIntent::Sse => V3HubResponseNormalizedKind::SseStreamPassthrough',
    diagnostic: /Relay SSE pass-through body kind/,
  },
  {
    name: 'Responses Relay stream collector resurrected',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    marker: 'use serde_json::{json, Value};',
    mutation: 'use serde_json::{json, Value};\nfn forbidden_responses_relay_collector_resurrected() { let _ = "collect_v3_responses_relay_sse_response"; }',
    diagnostic: /Responses Relay provider stream collection/,
  },
  {
    name: 'Responses Relay terminal shape materialization resurrected',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    marker: 'use serde_json::{json, Value};',
    mutation: 'use serde_json::{json, Value};\nfn forbidden_responses_relay_terminal_materialize_resurrected() { let _ = "complete_v3_runtime_sse_materialized_response"; }',
    diagnostic: /terminal response shape materialization/,
  },
  {
    name: 'Responses Relay synthetic SSE projection resurrected',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    marker: 'use serde_json::{json, Value};',
    mutation: 'use serde_json::{json, Value};\nfn forbidden_responses_relay_synthetic_projection_resurrected() { let _ = "project_finalized_response_sse_stream"; }',
    diagnostic: /synthetic SSE re-emission/,
  },
  {
    name: 'Responses Relay provider-inbound event codec owner removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    marker: 'ProviderRespInbound01Raw -> V3HubRespInbound02Normalized (Responses event codec; SSE transport is opaque framing)',
    mutation: 'ProviderRespInbound01Raw -> V3ServerRespOutbound06ClientFrame',
    diagnostic: /missing ProviderRespInbound01Raw -> V3HubRespInbound02Normalized/,
  },
  {
    name: 'Responses Relay SSE observer removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    marker: 'fn observe_v3_runtime_responses_sse_transport_chunk(',
    mutation: 'fn observe_v3_runtime_responses_sse_transport_chunk_removed(',
    diagnostic: /missing fn observe_v3_runtime_responses_sse_transport_chunk/,
  },
  {
    name: 'Responses Relay raw SSE pass-through projector resurrected',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    marker: 'use serde_json::{json, Value};',
    mutation: 'use serde_json::{json, Value};\nfn project_sse_stream() {}',
    diagnostic: /raw SSE transport pass-through/,
  },
  {
    name: 'provider WebSocket protocol aggregation owner removed',
    file: 'v3/crates/routecodex-v3-provider-responses/src/transport.rs',
    marker: 'V3ProviderResponsesWebSocketSession -> V3ProviderResp14Raw',
    mutation: 'V3ProviderResponsesWebSocketSession -> V3ProviderResp14ShapeRebuilt',
    diagnostic: /missing V3ProviderResponsesWebSocketSession -> V3ProviderResp14Raw/,
  },
  {
    name: 'Responses Relay raw SSE passthrough hook resurrected',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    marker: 'use serde_json::{json, Value};',
    mutation: 'use serde_json::{json, Value};\nfn run_sse_response_passthrough_hooks() {}',
    diagnostic: /raw SSE passthrough branch/,
  },
  {
    name: 'additional provider transport terminal output reconstruction',
    file: 'v3/crates/routecodex-v3-provider-responses/src/transport.rs',
    marker: 'use serde_json::{json, Value};',
    mutation: 'use serde_json::{json, Value};\nfn forbidden_provider_terminal_output_reconstruction(response: &Value) { let mut projected = response.clone(); let object = projected.as_object_mut().unwrap(); object.insert("output".to_string(), Value::Array(vec![])); }',
    diagnostic: /additional provider transport terminal response output reconstruction/,
  },
  {
    name: 'Debug snapshot truth substitution',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    marker: 'use serde_json::Value;',
    mutation: 'use serde_json::Value;\nfn forbidden_snapshot(debug_snapshot: &Value) { let continuation_truth_payload = debug_snapshot; let _ = continuation_truth_payload; }',
    diagnostic: /forbidden Debug\/snapshot truth substitution/,
  },
  {
    name: 'hook plan retained payload',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resource_hooks.rs',
    marker: 'use std::',
    mutation: 'struct HookPlan { retained_payload: serde_json::Value }\nuse std::',
    diagnostic: /forbidden hook planning payload retention or clone/,
  },
  {
    name: 'canonical payload sharing assertion removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
    marker: 'Arc::ptr_eq(&context.payload, self.previous.previous.provider_payload())',
    mutation: 'true',
    diagnostic: /missing Arc::ptr_eq/,
  },
  {
    name: 'Req04 restore ownership removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    marker: 'Ok(Some(Arc::clone(&local.canonical_context)))',
    mutation: 'Ok(None)',
    diagnostic: /missing Ok\(Some\(Arc::clone/,
  },
];

const failures = [];
for (const fixture of fixtures) {
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-relay-copy-red-'));
  try {
    for (const relative of ['v3', 'docs', 'scripts', 'package.json']) {
      cpSync(resolve(repoRoot, relative), join(root, relative), {
        recursive: true,
        filter: (source) => !source.includes('/target/'),
      });
    }
    const target = join(root, fixture.file);
    const source = readFileSync(target, 'utf8');
    if (!source.includes(fixture.marker)) {
      failures.push(`${fixture.name}: mutation marker missing`);
      continue;
    }
    writeFileSync(target, source.replace(fixture.marker, fixture.mutation));
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${fixture.name}: verifier unexpectedly passed`);
    else if (!fixture.diagnostic.test(output)) {
      failures.push(`${fixture.name}: wrong diagnostic: ${output.slice(-700)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error('[test:v3-relay-payload-copy-budget-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[test:v3-relay-payload-copy-budget-red-fixtures] ok (${fixtures.length} forbidden mutations rejected)`);
