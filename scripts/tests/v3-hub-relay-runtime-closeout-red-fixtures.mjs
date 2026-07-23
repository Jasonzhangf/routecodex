#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const verifier = resolve(repo, 'scripts/architecture/verify-v3-hub-relay-runtime-closeout.mjs');
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
    marker: 'let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04);',
    mutation: 'let _forbidden_resp05_before_commit = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04);\n        let _late_resp04_commit = hooks.commit(resp03)?;\n        let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04);',
    diagnostic: /expected 1 occurrences|forbidden/,
  },
  {
    name: 'second response exit appears',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs',
    marker: 'let _resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);',
    mutation: 'let _second_resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);\n        let _resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);',
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
    name: 'anthropic relay removes shared provider failure policy context usage',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs',
    marker: 'let failure_context = V3RelayProviderFailurePolicyContext {',
    mutation: 'let failure_context = V3RelayProviderFailureContext {',
    diagnostic: /missing ordered SSE response path phrase let failure_context = V3RelayProviderFailurePolicyContext/,
  },
  {
    name: 'openai chat relay resurrects local target resolver',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs',
    marker: 'let mut trace = Vec::with_capacity(17);',
    mutation: 'fn resolve_target() {}\n    let mut trace = Vec::with_capacity(17);',
    diagnostic: /resolve_target|forbidden/,
  },
  {
    name: 'openai chat relay records provider failure outside shared policy',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs',
    marker: 'let failure_context = V3RelayProviderFailurePolicyContext {',
    mutation: 'let _forbidden_record_provider_failure = provider_health.record_provider_failure("provider", "auth", "model", "reason", now_ms);\n    let failure_context = V3RelayProviderFailurePolicyContext {',
    diagnostic: /record_provider_failure|forbidden/,
  },
  {
    name: 'gemini relay resurrects provider runtime error output',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs',
    marker: 'let mut trace = Vec::with_capacity(17);',
    mutation: 'fn provider_runtime_error_output() {}\n    let mut trace = Vec::with_capacity(17);',
    diagnostic: /provider_runtime_error_output|forbidden/,
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
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    marker: 'pub struct V3ResponsesRelayRetryPolicy {',
    mutation: 'struct V3ResponsesRelayExcludedAvailability;\npub struct V3ResponsesRelayRetryPolicy {',
    diagnostic: /V3ResponsesRelayExcludedAvailability|forbidden/,
  },
  {
    name: 'responses relay resurrects local target resolver',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    marker: 'pub struct V3ResponsesRelayRetryPolicy {',
    mutation: 'fn resolve_target() {}\npub struct V3ResponsesRelayRetryPolicy {',
    diagnostic: /resolve_target|forbidden/,
  },
  {
    name: 'responses relay runtime reintroduces P6 direct policy',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    marker: 'let mut trace = Vec::with_capacity(17);',
    mutation: 'let _p6_shortcut = "V3ResponsesDirect11Policy";\n    let mut trace = Vec::with_capacity(17);',
    diagnostic: /ResponsesDirect|forbidden/,
  },
  {
    name: 'responses relay streaming trace drops response chat process node',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    marker: 'trace.push("V3HubRespChatProcess03Governed");',
    mutation: 'trace.push("V3HubRespOutbound05ClientSemantic");',
    diagnostic: /expected 2 occurrences.*V3HubRespChatProcess03Governed|missing V3HubRespChatProcess03Governed/,
  },
  {
    name: 'responses relay SSE skips response hooks before client projection',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    marker: 'let (action, finalized_provider_value, response_stopless_state) =',
    mutation: 'let (forbidden_action, finalized_provider_value, response_stopless_state) =',
    diagnostic: /expected 2 occurrences of let \(action, finalized_provider_value, response_stopless_state\)|missing ordered SSE response path phrase/,
  },
  {
    name: 'responses relay SSE resurrects raw pass-through projector',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    marker: 'use serde_json::{json, Map, Value};',
    mutation: 'use serde_json::{json, Map, Value};\nfn project_sse_stream() {}',
    diagnostic: /project_sse_stream|forbidden/,
  },
  {
    name: 'responses relay local continuation restore removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    marker: 'with_local_context_from_req04_store(',
    mutation: 'removed_relay_restore_at_req04(',
    diagnostic: /missing with_local_context_from_req04_store/,
  },
  {
    name: 'responses relay runtime restores local continuation outside Req04 owner',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
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
    file: 'v3/crates/routecodex-v3-server/src/lib.rs',
    marker: 'if entry_protocol == "responses" && execution_mode == V3EntryProtocolExecutionMode::Relay {',
    mutation: 'if entry_protocol == "responses" && execution_mode == V3EntryProtocolExecutionMode::Direct {',
    diagnostic: /must appear after occurrence|missing ordered occurrence/,
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
];

const copyPaths = [
  'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs',
  'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs',
  'v3/crates/routecodex-v3-runtime/tests/hub_relay_runtime_closeout.rs',
  'v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
  'v3/crates/routecodex-v3-server/src/lib.rs',
  'v3/crates/routecodex-v3-server/tests/multi_listener_server.rs',
  'docs/architecture/manifests/v3.hub_relay.runtime_closeout.mainline.yml',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'docs/architecture/wiki/v3-hub-relay-fixed-pipeline.md',
  'package.json',
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
