#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

const runtimePath = 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs';
const codecPath = 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs';
const hubPath = 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs';
const testsPath = 'v3/crates/routecodex-v3-runtime/tests/gemini_relay_runtime_integration.rs';
const designPath = 'docs/goals/v3-gemini-relay-runtime-integration-test-design.md';
const serverPath = 'v3/crates/routecodex-v3-server/src/lib.rs';
const serverTestsPath = 'v3/crates/routecodex-v3-server/tests/gemini_relay_controlled.rs';
const configValidatePath = 'v3/crates/routecodex-v3-config/src/validate.rs';
const configTestsPath = 'v3/crates/routecodex-v3-config/tests/config_v3_contract.rs';
const virtualRouterPath = 'v3/crates/routecodex-v3-virtual-router/src/lib.rs';
const functionMapPath = 'docs/architecture/v3-function-map.yml';
const mainlineMapPath = 'docs/architecture/v3-mainline-call-map.yml';
const resourceMapPath = 'docs/architecture/v3-resource-operation-map.yml';
const verificationMapPath = 'docs/architecture/v3-verification-map.yml';
const manifestPath = 'docs/architecture/manifests/v3.gemini_relay.controlled_runtime.mainline.yml';
const entryBindingManifestPath = 'docs/architecture/manifests/v3.entry_protocol_endpoint_binding.mainline.yml';
const wikiPath = 'docs/architecture/wiki/v3-gemini-relay-controlled-runtime.md';
const wikiHtmlPath = 'docs/architecture/wiki/html/v3-gemini-relay-controlled-runtime.html';
const packagePath = 'package.json';

const runtime = read(runtimePath);
const codec = read(codecPath);
const hub = read(hubPath);
const tests = read(testsPath);
const design = read(designPath);
const server = read(serverPath);
const serverTests = read(serverTestsPath);
const configValidate = read(configValidatePath);
const configTests = read(configTestsPath);
const virtualRouter = read(virtualRouterPath);
const functionMap = read(functionMapPath);
const mainlineMap = read(mainlineMapPath);
const resourceMap = read(resourceMapPath);
const verificationMap = read(verificationMapPath);
const manifest = read(manifestPath);
const entryBindingManifest = read(entryBindingManifestPath);
const wiki = read(wikiPath);
const wikiHtml = read(wikiHtmlPath);
const packageJson = read(packagePath);
const failures = [];

requirePackageScript('test:v3-gemini-relay-runtime-integration', 'CARGO_NET_OFFLINE=true cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime --test gemini_relay_runtime_integration -- --nocapture && CARGO_NET_OFFLINE=true cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-server --test gemini_relay_controlled -- --nocapture');
requirePackageScript('verify:v3-gemini-relay-runtime-integration', 'node scripts/architecture/verify-v3-gemini-relay-runtime-integration.mjs');
requirePackageScript('test:v3-gemini-relay-runtime-integration-red-fixtures', 'node scripts/tests/v3-gemini-relay-runtime-integration-red-fixtures.mjs');

for (const phrase of [
  'execute_v3_gemini_relay_runtime_with_default_transport',
  'execute_v3_gemini_relay_runtime',
  'compile_v3_hub_v1_static_registry()',
  'V3HubEntryProtocol::Gemini',
  'V3HubProviderWireProtocol::Gemini',
  'characterize_v3_gemini_client_input_to_hub_semantic',
  'characterize_v3_gemini_hub_semantic_to_provider_wire',
  'characterize_v3_gemini_provider_raw_to_hub_response_semantic',
  'characterize_v3_gemini_hub_response_semantic_to_client_projection',
  'run_from_normalized',
  'build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04',
  'build_v3_hub_req_target_06_from_v3_hub_req_execution_05',
  'build_v3_hub_req_outbound_07_from_v3_hub_req_target_06',
  'build_provider_req_compat_06_from_v3_hub_req_outbound_07',
  'build_v3_provider_req_outbound_08_from_provider_req_compat_06',
  'build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08',
  'build_v3_gemini_transport_09',
  'target.wire_model',
  'transport.send(transport_request).await',
  'build_v3_provider_resp_inbound_01_raw',
  'hooks.normalize(resp01)',
  'hooks.govern(resp02',
  'hooks.commit(resp03)',
  'build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04',
  'build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05',
  'V3_ERROR_CHAIN_NODE_IDS',
  'SseIncrementalDecoder',
  'Gemini SSE ended without terminal finishReason',
  'Gemini SSE emitted a frame after terminal finishReason',
  'gemini_model_from_endpoint_path',
  'gemini_routing_payload',
]) requireText(runtime, runtimePath, phrase);

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
]) requireText(runtime, runtimePath, 'trace.push("' + node + '")');

for (const phrase of [
  'json_runtime_executes_one_hub_lifecycle_and_preserves_gemini_semantics',
  'json_function_call_governance_preserves_gemini_name_mapping',
  'sse_runtime_emits_first_gemini_event_before_provider_terminal_without_materializing',
  'malformed_non_terminal_and_post_terminal_sse_fail_explicitly',
  'provider_error_enters_error01_06_without_success_projection',
  'malformed_provider_error_body_projects_explicit_error_not_fallback',
  'side_channel_request_fails_before_provider_send',
  'response_side_channel_is_rejected_for_json_and_sse_before_client_success',
]) requireText(tests, testsPath, phrase);
for (const phrase of [
  'server_executes_controlled_json_sse_error_and_isolation_without_second_owner',
  '/v1beta/models/gemini-wire/generateContent',
  'client first Gemini frame must arrive before controlled terminal delay',
  'metadata_center',
  'x-routecodex-v3-error-chain',
]) requireText(serverTests, serverTestsPath, phrase);
for (const phrase of ['White-box Matrix', 'Runtime Module Black-box', 'Server Loopback Black-box', 'Known Gaps', 'No real Gemini provider']) {
  requireText(design, designPath, phrase);
}

for (const [text, owner, phrases] of [
  [functionMap, functionMapPath, ['feature_id: v3.gemini_relay_runtime_integration', 'v3.gemini.client_sse_stream']],
  [mainlineMap, mainlineMapPath, ['chain_id: v3.gemini_relay.controlled_runtime', 'v3-gemini-relay-15', 'execute_v3_gemini_generate_content_request']],
  [resourceMap, resourceMapPath, ['resource_id: v3.gemini.client_sse_stream', 'allowed_readers: [gemini_relay_output_response]']],
  [verificationMap, verificationMapPath, ['feature_id: v3.gemini_relay_runtime_integration', 'malformed SSE JSON non-terminal stream end and frames after terminal finishReason fail explicitly']],
  [manifest, manifestPath, ['lifecycle_id: v3.gemini_relay.controlled_runtime', 'V3ServerRespOutbound06ClientFrame', 'v3-gemini-relay-15']],
  [wiki, wikiPath, ['Single lifecycle', 'Body::from_stream', 'Live Gemini provider compatibility', 'No fallback']],
  [wikiHtml, wikiHtmlPath, ['Canonical Markdown source:', 'V3 Gemini Relay Controlled Runtime', 'Body::from_stream', 'No fallback']],
  [entryBindingManifest, entryBindingManifestPath, ['entry_protocol: gemini', 'execution_mode: relay', 'implementation_status: implemented', 'execute_v3_gemini_relay_runtime_with_default_transport']],
]) for (const phrase of phrases) requireText(text, owner, phrase);

requireText(hub, hubPath, 'mod gemini_relay_runtime;');
for (const phrase of [
  'execute_v3_gemini_relay_runtime_with_default_transport',
  'V3GeminiRelayClientBody::Sse',
  'Body::from_stream(client_stream)',
  'entry_protocol_binding_for_endpoint(&path)',
  'entry_protocol == "gemini"',
  'execute_v3_gemini_generate_content_request',
]) requireText(server, serverPath, phrase);
for (const phrase of [
  'expected_entry_protocol_execution_mode',
  '"anthropic" | "openai_chat" | "gemini"',
  'execute_v3_gemini_relay_runtime_with_default_transport',
  'gemini entry protocol must be relay',
]) requireText(configValidate + '\n' + configTests, 'routecodex-v3-config', phrase);
for (const phrase of [
  'protocol_from_endpoint',
  'endpoint.starts_with("/v1beta/models/")',
  'endpoint.ends_with("/generateContent")',
  'return "gemini".to_string();',
]) requireText(virtualRouter, virtualRouterPath, phrase);
for (const phrase of ['metadata_center', 'debug_snapshot', 'resource_handle', 'continuation_owner']) requireText(codec, codecPath, phrase);

const geminiServerProjection = slice(server, 'fn gemini_relay_output_response', 'fn anthropic_relay_output_response');
forbid(geminiServerProjection, serverPath, [
  /client_response[\s\S]{0,220}get\("candidates"\)/,
  /gemini_relay_output_response[\s\S]{0,1500}(?:functionCall|finishReason|usageMetadata|candidates)/,
]);

forbid(runtime, runtimePath, [
  /fallback/i,
  /ResponsesDirect(?:Runtime|11Policy)|execute_v3_responses_direct/i,
  /dynamic[_ -]?hook|libloading|read_dir/i,
  /into_body_bytes|collect::<Vec<u8>>|bodyText|sse_frames/i,
  /debug_snapshot|metadata_center|resource_handle|continuation_owner/,
  /unwrap_or(?:_else|_default)/,
]);

verifyYamlManifest();

if (failures.length) {
  console.error('[verify:v3-gemini-relay-runtime-integration] failed');
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}
console.log('[verify:v3-gemini-relay-runtime-integration] ok');

function read(path) {
  try { return readFileSync(path, 'utf8'); }
  catch (error) { failures.push(path + ': missing or unreadable: ' + error.message); return ''; }
}
function requireText(text, owner, phrase) {
  if (!text.includes(phrase)) failures.push(owner + ': missing ' + phrase);
}
function forbid(text, owner, patterns) {
  for (const pattern of patterns) if (pattern.test(text)) failures.push(owner + ': forbidden ' + pattern);
}
function slice(text, from, to) {
  const start = text.indexOf(from);
  if (start < 0) return '';
  const end = text.indexOf(to, start + from.length);
  return end >= 0 ? text.slice(start, end) : text.slice(start);
}
function requirePackageScript(name, expectedCommand) {
  try {
    const parsed = JSON.parse(packageJson);
    if (parsed.scripts?.[name] !== expectedCommand) failures.push(packagePath + ': script ' + name + ' must be ' + expectedCommand);
  } catch (error) {
    failures.push(packagePath + ': JSON parse failed: ' + error.message);
  }
}
function verifyYamlManifest() {
  let parsed;
  try { parsed = YAML.parse(manifest); }
  catch (error) { failures.push(manifestPath + ': YAML parse failed: ' + error.message); return; }
  if (parsed?.lifecycle_id !== 'v3.gemini_relay.controlled_runtime') failures.push(manifestPath + ': lifecycle_id mismatch');
  if (parsed?.owner_feature_id !== 'v3.gemini_relay_runtime_integration') failures.push(manifestPath + ': owner_feature_id mismatch');
  const edges = Array.isArray(parsed?.edges) ? parsed.edges : [];
  for (let index = 1; index <= 15; index += 1) {
    const step = 'v3-gemini-relay-' + String(index).padStart(2, '0');
    if (!edges.some((edge) => edge?.step_id === step && edge?.status === 'anchored')) failures.push(manifestPath + ': missing anchored edge ' + step);
  }
}
