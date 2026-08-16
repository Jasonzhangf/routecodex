#!/usr/bin/env node
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.cwd().endsWith('/v3') && existsSync(resolve(process.cwd(), 'crates'))) {
  process.chdir(resolve(process.cwd(), '..'));
}

const repo = process.cwd();
const verifier = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'architecture',
  'verify-v3-hub-relay-runtime-closeout.mjs',
);
const cases = [
  {
    name: 'runtime drops servertool response profile',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs',
    marker: 'hooks.govern(resp02, response_hook_profile)?',
    mutation: 'hooks.govern(resp02, &V3HubRelayResponseHookProfile::empty())?',
    diagnostic: /expected 1 occurrences|forbidden|missing ordered SSE response path phrase/,
  },
  {
    name: 'servertool followup evidence removed',
    file: 'v3/crates/routecodex-v3-runtime/tests/hub_relay_runtime_closeout.rs',
    marker: 'assert!(first.servertool_followup_required);',
    mutation: '',
    diagnostic: /missing assert!\(first\.servertool_followup_required\);|missing servertool_followup_required/,
  },
  {
    name: 'non-adjacent closeout shortcut appears',
    file: 'docs/architecture/manifests/v3.hub_relay.runtime_closeout.mainline.yml',
    marker: '  - { step_id: v3-hub-relay-closeout-03, from_node: V3HubReqContinuation03Classified, to_node: V3HubReqChatProcess04Governed, status: anchored, owner_feature_id: v3.hub_relay_runtime_closeout }',
    mutation: '  - { step_id: v3-hub-relay-closeout-03, from_node: V3HubReqContinuation03Classified, to_node: V3HubReqExecution05Planned, status: anchored, owner_feature_id: v3.hub_relay_runtime_closeout }',
    diagnostic: /edge v3-hub-relay-closeout-03 mismatch/,
  },
  {
    name: 'continuation commit moves after Resp05',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs',
    marker: 'let resp04 = hooks.commit(resp03)?;',
    mutation: 'let _forbidden_resp05_before_commit = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04_with_client_payload(resp04, client_payload);\n    let resp04 = hooks.commit(resp03)?;',
    diagnostic: /expected 1 occurrences|forbidden/,
  },
  {
    name: 'second response exit appears',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs',
    marker: 'let resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);',
    mutation: 'let _second_resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);\n    let resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);',
    diagnostic: /expected 1 occurrences/,
  },
  {
    name: 'dynamic hook discovery appears',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs',
    marker: 'let mut trace = Vec::with_capacity(17);',
    mutation: 'let _dynamic_hook_scan = std::fs::read_dir(".");\n    let mut trace = Vec::with_capacity(17);',
    diagnostic: /dynamic|read_dir|forbidden/,
  },
  {
    name: 'P6 direct shortcut appears',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs',
    marker: 'let mut trace = Vec::with_capacity(17);',
    mutation: 'let _shortcut = "ResponsesDirect11Policy";\n    let mut trace = Vec::with_capacity(17);',
    diagnostic: /ResponsesDirect|forbidden/,
  },
  {
    name: 'fallback appears',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs',
    marker: 'let transport_intent = if input.payload.get("stream").and_then(Value::as_bool) == Some(true) {',
    mutation: 'let fallback = false;\n    let transport_intent = if input.payload.get("stream").and_then(Value::as_bool) == Some(true) {',
    diagnostic: /fallback|forbidden/,
  },
  {
    name: 'responses relay removes shared provider failure policy call',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    marker: 'run_v3_relay_provider_failure_policy(',
    mutation: 'removed_v3_relay_provider_failure_policy(',
    diagnostic: /missing run_v3_relay_provider_failure_policy|missing ordered SSE response path phrase let result = run_v3_relay_provider_failure_policy/,
  },
  {
    name: 'responses relay resurrects local excluded availability',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_types.rs',
    marker: 'pub struct V3ResponsesRelayRetryPolicy {',
    mutation: 'struct V3ResponsesRelayExcludedAvailability;\npub struct V3ResponsesRelayRetryPolicy {',
    diagnostic: /V3ResponsesRelayExcludedAvailability|forbidden/,
  },
  {
    name: 'responses relay resurrects local target resolver',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_types.rs',
    marker: 'pub struct V3ResponsesRelayRetryPolicy {',
    mutation: 'fn resolve_target() {}\npub struct V3ResponsesRelayRetryPolicy {',
    diagnostic: /resolve_target|forbidden/,
  },
  {
    name: 'responses relay runtime reintroduces P6 direct policy',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs',
    marker: 'let mut trace = Vec::with_capacity(17);',
    mutation: 'let _p6_shortcut = "V3ResponsesDirect11Policy";\n    let mut trace = Vec::with_capacity(17);',
    diagnostic: /ResponsesDirect|forbidden/,
  },
  {
    name: 'responses relay streaming trace drops response chat process node',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_json_hooks.rs',
    marker: 'trace.push("V3HubRespChatProcess03Governed");',
    mutation: 'trace.push("V3HubRespOutbound05ClientSemantic");',
    diagnostic: /expected 1 occurrences.*V3HubRespChatProcess03Governed|missing V3HubRespChatProcess03Governed/,
  },
  {
    name: 'responses relay SSE skips response hooks before client projection',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs',
    marker: '                    mut finalized_provider_value,\n                    response_stopless_state,',
    mutation: '                    mut forbidden_finalized_provider_value,\n                    response_stopless_state,',
    diagnostic: /expected 2 occurrences of let \(\n                    action,\n                    mut finalized_provider_value,/,
  },
  {
    name: 'responses relay SSE resurrects raw pass-through projector',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    marker: 'use serde_json::{json, Map, Value};',
    mutation: 'use serde_json::{json, Map, Value};\nfn project_sse_stream() {}',
    diagnostic: /project_sse_stream|forbidden/,
  },
  {
    name: 'responses relay provider event codec owner is removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/responses_provider_event_codec.rs',
    marker: 'pub(super) fn observe_v3_runtime_responses_sse_transport_chunk(',
    mutation: 'pub(super) fn removed_v3_runtime_responses_sse_transport_chunk(',
    diagnostic: /missing fn observe_v3_runtime_responses_sse_transport_chunk\(/,
  },
  {
    name: 'responses relay parent resurrects provider event codec owner',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_types.rs',
    marker: 'pub struct V3ResponsesRelayRetryPolicy {',
    mutation: 'fn observe_v3_runtime_responses_sse_transport_chunk() {}\npub struct V3ResponsesRelayRetryPolicy {',
    diagnostic: /observe_v3_runtime_responses_sse_transport_chunk|forbidden/,
  },
  {
    name: 'responses relay local continuation restore removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs',
    marker: 'with_local_context_from_req04_store(',
    mutation: 'removed_relay_restore_at_req04(',
    diagnostic: /missing with_local_context_from_req04_store/,
  },
  {
    name: 'responses relay runtime restores local continuation outside Req04 owner',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs',
    marker: 'let store = local_store_guard',
    mutation: 'let _forbidden_runtime_restore = store.restore_at_req04(&request)?;\n            let store = local_store_guard',
    diagnostic: /restore_at_req04|forbidden/,
  },
  {
    name: 'responses relay local continuation commit removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    marker: 'commit_or_release_v3_relay_local_continuation_at_resp04',
    mutation: 'removed_relay_commit_at_resp04',
    diagnostic: /missing commit_or_release_v3_relay_local_continuation_at_resp04/,
  },
  {
    name: 'responses relay tools preservation assertion removed',
    file: 'v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
    marker: 'assert_original_tools_preserved(&captures[1], second_tools.as_array().unwrap());',
    mutation: '',
    diagnostic: /missing assert_original_tools_preserved/,
  },
  {
    name: 'server dispatch runs responses direct before relay',
    file: 'v3/crates/routecodex-v3-server/src/endpoint_handlers.rs',
    marker: 'if entry_protocol == "responses" && execution_mode == V3EntryProtocolExecutionMode::Relay {',
    mutation: 'if entry_protocol == "responses" && execution_mode == V3EntryProtocolExecutionMode::Direct {',
    diagnostic: /must appear after occurrence|missing ordered occurrence/,
  },
  {
    name: 'server relay finalizer bypasses the sole client response projector',
    file: 'v3/crates/routecodex-v3-server/src/live_snapshot.rs',
    marker: 'responses_relay_output_response(',
    mutation: 'removed_relay_client_response_projector(',
    diagnostic: /finalize_v3_responses_relay_server_output: missing responses_relay_output_response\(/,
  },
  {
    name: 'manifest owner drift',
    file: 'docs/architecture/manifests/v3.hub_relay.runtime_closeout.mainline.yml',
    marker: 'owner_feature_id: v3.hub_relay_runtime_closeout',
    mutation: 'owner_feature_id: v3.hub_relay_gate_review_surface',
    diagnostic: /owner_feature_id mismatch|edge v3-hub-relay-closeout/,
  },
  {
    name: 'live replay completion flag removed',
    file: 'docs/architecture/manifests/v3.hub_relay.runtime_closeout.mainline.yml',
    marker: '  live_replay_5555: true',
    mutation: '  live_replay_5555: false',
    diagnostic: /completion boundary must record live 5555 replay/,
  },
  {
    name: 'package gate removed',
    file: 'package.json',
    marker: '    "verify:v3-hub-relay-runtime-closeout": "node scripts/architecture/verify-v3-hub-relay-runtime-closeout.mjs",\n',
    mutation: '',
    diagnostic: /missing script verify:v3-hub-relay-runtime-closeout/,
  },
  {
    name: 'focused duplicate identity package gate removed',
    file: 'package.json',
    marker: '    "test:v3-5520-duplicate-tool-identity": "CARGO_NET_OFFLINE=true node scripts/run-v3-cargo-test.mjs -p routecodex-v3-runtime --lib terminal_merge -- --nocapture && CARGO_NET_OFFLINE=true node scripts/run-v3-cargo-test.mjs -p routecodex-v3-runtime --lib provider_response_failure_classifier_keeps_provider_and_local_hook_errors_separate -- --nocapture && CARGO_NET_OFFLINE=true node scripts/run-v3-cargo-test.mjs -p routecodex-v3-runtime --test hub_relay_runtime_closeout responses_relay_provider_duplicate_tool_identity -- --nocapture && npm run verify:v3-hub-relay-runtime-closeout && npm run test:v3-hub-relay-runtime-closeout-red-fixtures",\n',
    mutation: '',
    diagnostic: /missing script test:v3-5520-duplicate-tool-identity/,
  },
  {
    name: 'canonical V3 CI gate removed',
    file: '.github/workflows/test.yml',
    marker: '        run: npm --prefix v3 run verify:ci\n',
    mutation: '',
    diagnostic: /expected 1 occurrences of run: npm --prefix v3 run verify:ci, found 0/,
  },
  {
    name: 'provider response classifier regression test removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_tests.rs',
    marker: 'fn provider_response_failure_classifier_keeps_provider_and_local_hook_errors_separate()',
    mutation: 'fn removed_provider_response_failure_classifier_regression()',
    diagnostic: /missing provider_response_failure_classifier_keeps_provider_and_local_hook_errors_separate/,
  },
  {
    name: 'duplicate identity integration test removed',
    file: 'v3/crates/routecodex-v3-runtime/tests/hub_relay_runtime_closeout.rs',
    marker: 'responses_relay_provider_duplicate_tool_identity_reselects_before_projection_for_json_and_sse',
    mutation: 'removed_duplicate_tool_identity_reselection_regression',
    diagnostic: /missing responses_relay_provider_duplicate_tool_identity_reselects_before_projection_for_json_and_sse/,
  },
  {
    name: 'Resp03 provider failure entry edge removed',
    file: 'docs/architecture/v3-mainline-call-map.yml',
    marker: 'v3-hub-relay-response-failure-01',
    mutation: 'removed-hub-relay-response-failure-01',
    diagnostic: /missing v3-hub-relay-response-failure-01/,
  },
  {
    name: 'Resp03 provider failure provenance drifts to provider raw',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_failures.rs',
    marker: 'source_stage: "V3HubRespChatProcess03Governed"',
    mutation: 'source_stage: "V3ProviderRespInbound01Raw"',
    diagnostic: /missing source_stage: "V3HubRespChatProcess03Governed"/,
  },
  {
    name: 'Resp03 Error01 call-map callee drifts to local envelope helper',
    file: 'docs/architecture/v3-mainline-call-map.yml',
    marker: '    caller_symbol: build_v3_relay_provider_error_05_decision\n    caller_file: v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs\n    callee_symbol: build_v3_error_01_source_raised_external\n    callee_file: v3/crates/routecodex-v3-error/src/lib.rs',
    mutation: '    caller_symbol: build_v3_relay_provider_error_05_decision\n    caller_file: v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs\n    callee_symbol: provider_response_hook_failure\n    callee_file: v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    diagnostic: /callee_symbol must equal build_v3_error_01_source_raised_external/,
  },
  {
    name: 'shared relay Error01 builder call removed',
    file: 'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs',
    marker: 'let source = build_v3_error_01_source_raised_external(',
    mutation: 'let source = removed_v3_error_01_source_raised_external(',
    diagnostic: /missing build_v3_error_01_source_raised_external\(/,
  },
];

const copyPaths = [
  'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_json_hooks.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_failures.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_dry_run.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_stopless.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_chat_conversion.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_types.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_tests.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/responses_provider_event_codec.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/provider_stream_materialization.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_shared.rs',
  'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs',
  'v3/crates/routecodex-v3-runtime/tests/hub_relay_runtime_closeout.rs',
  'v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
  'v3/crates/routecodex-v3-server/src/lib.rs',
  'v3/crates/routecodex-v3-server/src/live_snapshot.rs',
  'v3/crates/routecodex-v3-server/src/executors.rs',
  'v3/crates/routecodex-v3-server/src/endpoint_handlers.rs',
  'v3/crates/routecodex-v3-server/src/frame_builders.rs',
  'v3/crates/routecodex-v3-server/src/websocket.rs',
  'v3/crates/routecodex-v3-server/tests/multi_listener_server.rs',
  'docs/architecture/manifests/v3.hub_relay.runtime_closeout.mainline.yml',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'docs/architecture/wiki/v3-hub-relay-fixed-pipeline.md',
  'package.json',
  '.github/workflows/test.yml',
];

const failures = [];
for (const testCase of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-hub-relay-closeout-red-'));
  try {
    for (const relative of copyPaths) {
      cpSync(resolve(repo, relative), resolve(root, relative), { recursive: true });
    }
    const target = resolve(root, testCase.file);
    const source = readFileSync(target, 'utf8');
    if (!source.includes(testCase.marker)) {
      failures.push(`${testCase.name}: mutation marker missing`);
      continue;
    }
    writeFileSync(target, source.replace(testCase.marker, testCase.mutation));
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${testCase.name}: verifier unexpectedly passed`);
    else if (!testCase.diagnostic.test(output)) {
      failures.push(`${testCase.name}: wrong diagnostic: ${output.slice(-700)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error('[test:v3-hub-relay-runtime-closeout-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-hub-relay-runtime-closeout-red-fixtures] ok (${cases.length} forbidden mutations rejected)`);
