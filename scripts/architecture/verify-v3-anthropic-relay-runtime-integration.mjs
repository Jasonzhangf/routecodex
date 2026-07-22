#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

const runtimePath = 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs';
const hubPath = 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs';
const reqTarget06Path = 'v3/crates/routecodex-v3-runtime/src/hub_v1/req_target_06_resolved.rs';
const providerReq09Path = 'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_req_outbound_09_transport_request.rs';
const codecPath = 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime_codec.rs';
const serverPath = 'v3/crates/routecodex-v3-server/src/lib.rs';
const driverPath = 'v3/crates/routecodex-v3-server/src/bin/v3-anthropic-relay-driver.rs';
const testPath = 'v3/crates/routecodex-v3-runtime/tests/anthropic_relay_runtime_integration.rs';
const designPath = 'docs/goals/v3-anthropic-relay-runtime-integration-test-design.md';
const manifestPath = 'docs/architecture/manifests/v3.anthropic_relay.controlled_runtime.mainline.yml';
const runtime = readFileSync(runtimePath, 'utf8');
const hub = readFileSync(hubPath, 'utf8');
const requestNodeSurface = [
  hub,
  readFileSync(reqTarget06Path, 'utf8'),
  readFileSync(providerReq09Path, 'utf8'),
].join('\n');
const codec = readFileSync(codecPath, 'utf8');
const server = readFileSync(serverPath, 'utf8');
const driver = readFileSync(driverPath, 'utf8');
const tests = readFileSync(testPath, 'utf8');
const design = readFileSync(designPath, 'utf8');
const manifest = YAML.parse(readFileSync(manifestPath, 'utf8'));
const failures = [];
const expectedManifestNodes = [
  'V3ServerValidatedMessagesRequest',
  'V3HubReqInbound01ClientRaw', 'V3HubReqInbound02Normalized',
  'V3HubReqContinuation03Classified', 'V3HubReqChatProcess04Governed',
  'V3HubReqExecution05Planned', 'V3HubReqTarget06Resolved',
  'V3HubReqOutbound07ProviderSemantic', 'ProviderReqCompat06ProviderCompat',
  'V3ProviderReqOutbound08WirePayload',
  'V3ProviderReqOutbound09TransportRequest', 'V3ProviderRespInbound01Raw',
  'ProviderRespCompat02ProviderCompat', 'V3HubRespInbound02Normalized',
  'V3HubRespChatProcess03Governed',
  'V3HubRespContinuation04Committed', 'V3HubRespOutbound05ClientSemantic',
  'V3ServerRespOutbound06ClientFrame',
];
if (manifest.lifecycle_id !== 'v3.anthropic_relay.controlled_runtime') {
  failures.push(`${manifestPath}: lifecycle_id mismatch`);
}
if (manifest.owner_feature_id !== 'v3.anthropic_relay_runtime_integration') {
  failures.push(`${manifestPath}: owner_feature_id mismatch`);
}
if (JSON.stringify(manifest.node_ids) !== JSON.stringify(expectedManifestNodes)) {
  failures.push(`${manifestPath}: fixed node order mismatch`);
}
const manifestEdges = Array.isArray(manifest.edges) ? manifest.edges : [];
if (manifestEdges.length !== 17) failures.push(`${manifestPath}: expected 17 adjacent edges`);
for (let index = 0; index < manifestEdges.length; index += 1) {
  const edge = manifestEdges[index];
  const expectedStep = `v3-anthropic-relay-${String(index + 1).padStart(2, '0')}`;
  if (edge.step_id !== expectedStep
      || edge.from_node !== expectedManifestNodes[index]
      || edge.to_node !== expectedManifestNodes[index + 1]
      || edge.status !== 'anchored') {
    failures.push(`${manifestPath}: edge ${expectedStep} mismatch`);
  }
}
if (manifest.entrypoint?.node_id !== expectedManifestNodes[0]
    || manifest.return_path?.node_id !== expectedManifestNodes.at(-1)
    || manifest.call_map_chain_id !== manifest.lifecycle_id) {
  failures.push(`${manifestPath}: entrypoint/return/call-map binding mismatch`);
}

const adjacentBuilders = [
  'run_v3_anthropic_relay_runtime_req_inbound',
  'run_from_normalized',
  'build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04',
  'build_v3_hub_req_target_06_from_v3_hub_req_execution_05',
  'build_v3_hub_req_outbound_07_from_v3_hub_req_target_06',
  'build_provider_req_compat_06_from_v3_hub_req_outbound_07',
  'build_v3_provider_req_outbound_08_from_provider_req_compat_06',
  'build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08',
  'build_v3_provider_resp_inbound_01_raw',
  'hooks.normalize(resp01)',
  'hooks.govern(resp02',
  'hooks.commit(resp03)',
  'build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04',
  'build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05',
];
for (const symbol of adjacentBuilders) requireText(runtime, runtimePath, symbol);
for (const node of [
  'V3HubReqInbound01ClientRaw', 'V3HubReqInbound02Normalized',
  'V3HubReqContinuation03Classified', 'V3HubReqChatProcess04Governed',
  'V3HubReqExecution05Planned', 'V3HubReqTarget06Resolved',
  'V3HubReqOutbound07ProviderSemantic', 'ProviderReqCompat06ProviderCompat',
  'V3ProviderReqOutbound08WirePayload',
  'V3ProviderReqOutbound09TransportRequest', 'V3ProviderRespInbound01Raw',
  'ProviderRespCompat02ProviderCompat', 'V3HubRespInbound02Normalized',
  'V3HubRespChatProcess03Governed',
  'V3HubRespContinuation04Committed', 'V3HubRespOutbound05ClientSemantic',
  'V3ServerRespOutbound06ClientFrame',
]) requireText(runtime, runtimePath, `trace.push("${node}")`);

for (const phrase of [
  'compile_v3_hub_v1_static_registry()',
  'transport.send(transport_request).await',
  'V3_ERROR_CHAIN_NODE_IDS',
  'project_v3_responses_sse_as_anthropic_events',
  'build_v3_sse_transport_in_01_raw_chunk',
]) requireText(`${runtime}\n${codec}`, 'runtime/codec', phrase);
for (const phrase of [
  'selected_target: routecodex_v3_target::V3TargetCandidate',
  'fn into_provider_semantic_payload(',
]) requireText(requestNodeSurface, `${hubPath}+node files`, phrase);

requireOrder(runtime, runtimePath, [
  'build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(',
  'trace.push("V3HubReqExecution05Planned")',
  'let selected = resolve_target(',
  'build_v3_hub_req_target_06_from_v3_hub_req_execution_05(',
  'trace.push("V3HubReqTarget06Resolved")',
  'build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(',
  'trace.push("V3HubReqOutbound07ProviderSemantic")',
  'build_provider_req_compat_06_from_v3_hub_req_outbound_07(',
  'trace.push("ProviderReqCompat06ProviderCompat")',
  'build_v3_provider_req_outbound_08_from_provider_req_compat_06(',
  'build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(',
  'build_v3_provider_12_responses_wire_payload(',
  'trace.push("V3ProviderReqOutbound08WirePayload")',
  'build_v3_transport_13_responses_http_request_from_v3_provider_12(',
  'trace.push("V3ProviderReqOutbound09TransportRequest")',
  'transport.send(transport_request).await',
]);

for (const phrase of [
  '.route("/v1/messages", post(pending_endpoint))',
  'execute_v3_anthropic_messages_request(',
  'execute_v3_anthropic_relay_runtime_with_default_transport(manifest, input).await',
]) requireText(server, serverPath, phrase);
requireText(driver, driverPath, 'use routecodex_v3_server::execute_v3_anthropic_messages_request;');
requireText(driver, driverPath, 'execute_v3_anthropic_messages_request(');

for (const phrase of [
  'json_runtime_uses_one_fixed_hub_lifecycle_and_exact_provider_wire',
  'provider_error_enters_error01_06_without_success_projection',
  'structured_sse_contract_preserves_reasoning_tool_and_terminal_order',
]) requireText(tests, testPath, phrase);
for (const phrase of [
  '74e56c98d05ced968949acdd5d73a05d2a78330cc58a50cae5445a30f50ff50e',
  'status=wiring_missing',
  'exactly one real provider request',
  'does not prove live 5555',
]) requireText(design, designPath, phrase);

forbid(runtime, runtimePath, [
  /SUCCESS_TRACE|expected_node_trace|fixture/i,
  /fallback/i,
  /dynamic[_ -]?hook|libloading|read_dir/i,
  /ResponsesDirect(?:Runtime|11Policy)|execute_v3_responses_direct/i,
  /serde_json::(?:to_value|from_value|to_string|from_str)\([^)]*payload/i,
  /payload\.clone\s*\(/,
]);
forbid(codec, codecPath, [
  /fallback/i,
  /debug_snapshot|metadata_center|resource_handle|runtime_control|selected_target/i,
  /input\.clone\s*\(/,
]);
forbid(driver, driverPath, [
  /execute_v3_anthropic_relay_runtime(?:_with_default_transport)?/,
  /expected_(?:upstream_request|client_response|node_trace)/,
]);
forbid(server, serverPath, [
  /response\.reasoning_summary|response\.output_item|function_call_arguments|message_stop.*=>/,
  /compile_v3_hub_relay_request_hooks|compile_v3_hub_relay_response_hooks/,
]);

if (failures.length) {
  console.error('[verify:v3-anthropic-relay-runtime-integration] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-anthropic-relay-runtime-integration] ok');

function requireText(text, owner, phrase) {
  if (!text.includes(phrase)) failures.push(`${owner}: missing ${phrase}`);
}
function forbid(text, owner, patterns) {
  for (const pattern of patterns) if (pattern.test(text)) failures.push(`${owner}: forbidden ${pattern}`);
}
function requireOrder(text, owner, phrases) {
  let cursor = 0;
  for (const phrase of phrases) {
    const index = text.indexOf(phrase, cursor);
    if (index < 0) {
      failures.push(`${owner}: missing or reordered ${phrase}`);
      return;
    }
    cursor = index + phrase.length;
  }
}
