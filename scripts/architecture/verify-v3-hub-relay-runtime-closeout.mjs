#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

const runtimePath = 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs';
const responsesRuntimePath = 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs';
const serverPath = 'v3/crates/routecodex-v3-server/src/lib.rs';
const serverTestPath = 'v3/crates/routecodex-v3-server/tests/multi_listener_server.rs';
const testPath = 'v3/crates/routecodex-v3-runtime/tests/hub_relay_runtime_closeout.rs';
const localContinuationTestPath = 'v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs';
const manifestPath = 'docs/architecture/manifests/v3.hub_relay.runtime_closeout.mainline.yml';
const functionMapPath = 'docs/architecture/v3-function-map.yml';
const mainlinePath = 'docs/architecture/v3-mainline-call-map.yml';
const verificationPath = 'docs/architecture/v3-verification-map.yml';
const wikiPath = 'docs/architecture/wiki/v3-hub-relay-fixed-pipeline.md';
const packagePath = 'package.json';

const runtime = readFileSync(runtimePath, 'utf8');
const responsesRuntime = readFileSync(responsesRuntimePath, 'utf8');
const server = readFileSync(serverPath, 'utf8');
const serverTests = readFileSync(serverTestPath, 'utf8');
const tests = readFileSync(testPath, 'utf8');
const localContinuationTests = readFileSync(localContinuationTestPath, 'utf8');
const manifest = YAML.parse(readFileSync(manifestPath, 'utf8'));
const functionMap = readFileSync(functionMapPath, 'utf8');
const mainline = readFileSync(mainlinePath, 'utf8');
const verification = readFileSync(verificationPath, 'utf8');
const wiki = readFileSync(wikiPath, 'utf8');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
const failures = [];

const expectedNodes = [
  'V3HubReqInbound01ClientRaw',
  'V3HubReqInbound02Normalized',
  'V3HubReqContinuation03Classified',
  'V3HubReqChatProcess04Governed',
  'V3HubReqExecution05Planned',
  'V3HubReqTarget06Resolved',
  'V3HubReqOutbound07ProviderSemantic',
  'V3ProviderReqOutbound08WirePayload',
  'V3ProviderReqOutbound09TransportRequest',
  'V3ProviderRespInbound01Raw',
  'V3HubRespInbound02Normalized',
  'V3HubRespChatProcess03Governed',
  'V3HubRespContinuation04Committed',
  'V3HubRespOutbound05ClientSemantic',
  'V3ServerRespOutbound06ClientFrame',
];

if (manifest.lifecycle_id !== 'v3.hub_relay.runtime_closeout') {
  failures.push(`${manifestPath}: lifecycle_id mismatch`);
}
if (manifest.owner_feature_id !== 'v3.hub_relay_runtime_closeout') {
  failures.push(`${manifestPath}: owner_feature_id mismatch`);
}
if (JSON.stringify(manifest.node_ids) !== JSON.stringify(expectedNodes)) {
  failures.push(`${manifestPath}: fixed node order mismatch`);
}
if (manifest.entrypoint?.node_id !== expectedNodes[0]
  || manifest.return_path?.node_id !== expectedNodes.at(-1)
  || manifest.call_map_chain_id !== manifest.lifecycle_id) {
  failures.push(`${manifestPath}: entry/return/call-map binding mismatch`);
}
if (!Array.isArray(manifest.edges) || manifest.edges.length !== expectedNodes.length - 1) {
  failures.push(`${manifestPath}: expected 14 adjacent closeout edges`);
} else {
  manifest.edges.forEach((edge, index) => {
    const expectedStep = `v3-hub-relay-closeout-${String(index + 1).padStart(2, '0')}`;
    if (edge.step_id !== expectedStep
      || edge.from_node !== expectedNodes[index]
      || edge.to_node !== expectedNodes[index + 1]
      || edge.owner_feature_id !== 'v3.hub_relay_runtime_closeout'
      || edge.status !== 'anchored') {
      failures.push(`${manifestPath}: edge ${expectedStep} mismatch`);
    }
  });
}
if (manifest.completion_boundary?.live_replay_5555 !== true
  || manifest.completion_boundary?.global_install_restart !== true
  || manifest.completion_boundary?.p6_deletion !== false) {
  failures.push(`${manifestPath}: completion boundary must record live 5555 replay/global install with P6 deletion still false`);
}

for (const script of [
  'test:v3-hub-relay-runtime-closeout',
  'verify:v3-hub-relay-runtime-closeout',
  'test:v3-hub-relay-runtime-closeout-red-fixtures',
  'test:v3-relay-payload-copy-runtime-probes',
  'verify:v3-relay-payload-copy-budget',
  'test:v3-relay-payload-copy-budget-red-fixtures',
]) {
  if (!packageJson.scripts?.[script]) failures.push(`${packagePath}: missing script ${script}`);
}

requireText(runtime, runtimePath, 'execute_v3_anthropic_relay_runtime_with_local_continuation_and_servertool_profile');
requireText(runtime, runtimePath, 'response_hook_profile: V3HubRelayResponseHookProfile');
requireCount(runtime, runtimePath, 'hooks.govern(resp02, &response_hook_profile)?', 2);
requireCount(runtime, runtimePath, 'let resp04 = hooks.commit(resp03)?;', 2);
requireCount(runtime, runtimePath, 'build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04)', 2);
requireCount(runtime, runtimePath, 'build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05)', 2);
requireOrdered(
  runtime,
  runtimePath,
  'let resp04 = hooks.commit(resp03)?;',
  'build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04)',
  2,
);
requireText(runtime, runtimePath, 'servertool_followup_required');
forbid(runtime, runtimePath, [
  /hooks\.govern\(resp02,\s*&V3HubRelayResponseHookProfile::empty\(\)\)/,
  /fallback/i,
  /ResponsesDirect(?:Runtime|11Policy)|execute_v3_responses_direct/i,
  /dynamic[_ -]?hook|libloading|read_dir/i,
  /build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04[\s\S]{0,240}hooks\.commit\(resp03\)/,
]);

for (const phrase of [
  'EXPECTED_RELAY_TRACE',
  'controlled_json_and_sse_e2e_use_fixed_topology_and_one_response_exit',
  'responses_relay_json_and_sse_enter_fixed_topology_without_p6_direct_nodes',
  'local_continuation_servertool_roundtrip_is_runtime_e2e',
  'provider_error_closeout_enters_error01_06_without_success_projection',
  'execute_v3_anthropic_relay_runtime_with_local_continuation_and_servertool_profile',
  'execute_v3_responses_relay_runtime',
  'servertool.exec',
  'assert!(first.servertool_followup_required);',
  'V3_ERROR_CHAIN_NODE_IDS',
  'session-closeout',
  'conversation-closeout',
  'metadata_center',
]) requireText(tests, testPath, phrase);
for (const node of expectedNodes) requireText(tests, testPath, node);
forbid(tests, testPath, [
  /fallback/i,
  /ResponsesDirect(?:Runtime|11Policy)|execute_v3_responses_direct/i,
  /read_dir|libloading|dynamic[_ -]?hook/i,
  /collect\s*::<\s*Vec|full_buffer|materiali[sz]e/i,
]);

for (const phrase of [
  'execute_v3_responses_relay_runtime_with_default_transport',
  'execute_v3_responses_relay_runtime_with_default_transport_and_local_continuation',
  'execute_v3_responses_relay_runtime_with_local_continuation',
  'V3ResponsesRelayLocalContinuationState',
  'V3ResponsesRelayLocalContinuationScope',
  'find_responses_tool_output_ids',
  'merge_v3_relay_restored_local_context_at_req04',
  'commit_or_release_v3_relay_local_continuation_at_resp04',
  'execute_v3_responses_relay_runtime',
  'execute_v3_responses_relay_dry_run_runtime',
  'project_v3_responses_relay_runtime_failure',
  'V3HubEntryProtocol::Responses',
  'V3HubExecutionMode::Relay',
  'compile_v3_hub_relay_request_hooks().run_from_normalized',
  'build_v3_provider_12_responses_wire_payload',
  'build_v3_transport_13_responses_http_request_from_v3_provider_12',
  'run_json_response_hooks',
  'push_streaming_response_trace',
  'project_sse_stream',
]) requireText(responsesRuntime, responsesRuntimePath, phrase);
for (const node of expectedNodes) requireText(responsesRuntime, responsesRuntimePath, node);
for (const node of expectedNodes.slice(9)) {
  requireCount(responsesRuntime, responsesRuntimePath, node, 2);
}
forbid(responsesRuntime, responsesRuntimePath, [
  /fallback/i,
  /ResponsesDirect(?:Runtime|11Policy)|execute_v3_responses_direct/i,
  /V3TargetLocalReselected/,
  /dynamic[_ -]?hook|libloading|read_dir/i,
  /collect\s*::<\s*Vec|full_buffer|materiali[sz]e/i,
]);

for (const phrase of [
  'execute_v3_responses_relay_request',
  'responses_relay_output_response',
  'execute_v3_responses_relay_runtime_with_default_transport_and_local_continuation',
  'responses_relay_local_continuation',
  'project_v3_responses_relay_runtime_failure',
  'is_provider_request_dry_run(&request_headers)',
  'execute_v3_responses_relay_dry_run_runtime',
  'return responses_relay_output_response(output);',
]) requireText(server, serverPath, phrase);
for (const phrase of [
  'json_two_turn_restores_tool_call_pairs_output_and_preserves_tools',
  'wrong_tool_output_id_fails_before_provider_send_and_keeps_saved_context',
  'assert_eq!(captures[1]["tools"], second_tools);',
  '"type":"function_call_output"',
  'assert_eq!(transport.captures.lock().unwrap().len(), 1);',
]) requireText(localContinuationTests, localContinuationTestPath, phrase);
requireOrdered(
  server,
  serverPath,
  'if entry_protocol == "responses" && execution_mode == V3EntryProtocolExecutionMode::Relay {',
  'if entry_protocol == "responses" && execution_mode == V3EntryProtocolExecutionMode::Direct {',
  1,
);
for (const phrase of [
  'responses_relay_manifest',
  'controlled_responses_relay_upstream',
  'responses_relay_endpoint_uses_hub_relay_runtime_for_json_and_sse',
  'responses_relay_provider_request_dry_run_header_returns_final_request_without_upstream_send',
  'V3ResponsesDirect11Policy',
  'V3TargetLocalReselected',
]) requireText(serverTests, serverTestPath, phrase);

for (const [path, text] of [
  [functionMapPath, functionMap],
  [mainlinePath, mainline],
  [verificationPath, verification],
  [wikiPath, wiki],
]) {
  requireText(text, path, 'v3.hub_relay_runtime_closeout');
  requireText(text, path, 'v3-hub-relay-closeout-01');
  requireText(text, path, 'v3-hub-relay-closeout-14');
  requireText(text, path, 'Responses Relay source');
}
for (const phrase of [
  'v3.responses_relay.source_server_entry',
  'v3-responses-relay-server-01',
  'v3-responses-relay-server-04',
]) {
  requireText(mainline, mainlinePath, phrase);
}
for (const phrase of [
  'source_entry_bindings',
  'execute_v3_responses_relay_runtime_with_default_transport',
  'live_replay_5555',
]) {
  requireText(readFileSync(manifestPath, 'utf8'), manifestPath, phrase);
}
for (const phrase of [
  'Live 5555 Responses Relay JSON/SSE validation is verified',
  'no Direct/P6 markers',
]) {
  requireText(wiki, wikiPath, phrase);
}

if (failures.length) {
  console.error('[verify:v3-hub-relay-runtime-closeout] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-hub-relay-runtime-closeout] ok');

function requireText(text, owner, phrase) {
  if (!text.includes(phrase)) failures.push(`${owner}: missing ${phrase}`);
}

function requireCount(text, owner, phrase, expected) {
  const actual = text.split(phrase).length - 1;
  if (actual !== expected) {
    failures.push(`${owner}: expected ${expected} occurrences of ${phrase}, found ${actual}`);
  }
}

function requireOrdered(text, owner, earlier, later, expected) {
  let index = 0;
  for (let occurrence = 0; occurrence < expected; occurrence += 1) {
    const earlierIndex = text.indexOf(earlier, index);
    if (earlierIndex < 0) {
      failures.push(`${owner}: missing ordered occurrence ${occurrence + 1} of ${earlier}`);
      return;
    }
    const laterIndex = text.indexOf(later, earlierIndex + earlier.length);
    if (laterIndex < 0) {
      failures.push(`${owner}: ${later} must appear after occurrence ${occurrence + 1} of ${earlier}`);
      return;
    }
    index = laterIndex + later.length;
  }
}

function forbid(text, owner, patterns) {
  for (const pattern of patterns) {
    if (pattern.test(text)) failures.push(`${owner}: forbidden ${pattern}`);
  }
}
