#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const runtimePath = 'v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs';
const hubPath = 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs';
const testsPath = 'v3/crates/routecodex-v3-runtime/tests/openai_chat_relay_runtime_integration.rs';
const designPath = 'docs/goals/v3-openai-chat-relay-runtime-integration-test-design.md';
const serverPath = 'v3/crates/routecodex-v3-server/src/lib.rs';
const serverTestsPath = 'v3/crates/routecodex-v3-server/tests/openai_chat_relay_controlled.rs';
const functionMapPath = 'docs/architecture/v3-function-map.yml';
const mainlineMapPath = 'docs/architecture/v3-mainline-call-map.yml';
const resourceMapPath = 'docs/architecture/v3-resource-operation-map.yml';
const verificationMapPath = 'docs/architecture/v3-verification-map.yml';
const manifestPath = 'docs/architecture/manifests/v3.openai_chat_relay.controlled_runtime.mainline.yml';
const wikiPath = 'docs/architecture/wiki/v3-openai-chat-relay-controlled-runtime.md';
const wikiHtmlPath = 'docs/architecture/wiki/html/v3-openai-chat-relay-controlled-runtime.html';
const runtime = readFileSync(runtimePath, 'utf8');
const hub = readFileSync(hubPath, 'utf8');
const tests = readFileSync(testsPath, 'utf8');
const design = readFileSync(designPath, 'utf8');
const server = readFileSync(serverPath, 'utf8');
const serverTests = readFileSync(serverTestsPath, 'utf8');
const functionMap = readFileSync(functionMapPath, 'utf8');
const mainlineMap = readFileSync(mainlineMapPath, 'utf8');
const resourceMap = readFileSync(resourceMapPath, 'utf8');
const verificationMap = readFileSync(verificationMapPath, 'utf8');
const manifest = readFileSync(manifestPath, 'utf8');
const wiki = readFileSync(wikiPath, 'utf8');
const wikiHtml = readFileSync(wikiHtmlPath, 'utf8');
const openaiServer = server.slice(
  server.indexOf('fn openai_chat_relay_output_response'),
  server.indexOf('fn anthropic_relay_output_response'),
);
const failures = [];

for (const phrase of [
  'execute_v3_openai_chat_relay_runtime',
  'compile_v3_hub_v1_static_registry()',
  'run_from_normalized',
  'build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04',
  'build_v3_hub_req_target_06_from_v3_hub_req_execution_05',
  'build_v3_hub_req_outbound_07_from_v3_hub_req_target_06',
  'build_provider_req_compat_06_from_v3_hub_req_outbound_07',
  'build_v3_provider_req_outbound_08_from_provider_req_compat_06',
  'build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08',
  'build_v3_openai_chat_transport_09_from_v3_provider_08',
  'transport.send(transport_request).await',
  'build_v3_provider_resp_inbound_01_raw',
  'hooks.normalize(resp01)',
  'hooks.govern(resp02',
  'hooks.commit(resp03)',
  'build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04',
  'build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05',
  'V3_ERROR_CHAIN_NODE_IDS',
  'SseIncrementalDecoder',
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
  'json_runtime_executes_one_hub_lifecycle_and_preserves_chat_semantics',
  'sse_runtime_preserves_split_frames_tool_delta_terminal_and_done_order',
  'sse_first_client_frame_is_observable_before_provider_terminal',
  'sse_done_before_terminal_and_terminal_without_done_fail_explicitly',
  'provider_error_enters_error01_06_without_success_projection',
  'request_side_channel_is_rejected_before_provider_transport',
]) requireText(tests, testsPath, phrase);
for (const phrase of [
  'server_executes_controlled_json_sse_error_and_isolation_without_second_owner',
  '/v1/chat/completions',
  'client first frame must arrive before controlled terminal delay',
  'metadata_center',
  'x-routecodex-v3-error-chain',
]) requireText(serverTests, serverTestsPath, phrase);
for (const phrase of ['Red baseline', 'MissingStatus', 'does not prove live provider compatibility']) {
  requireText(design, designPath, phrase);
}
for (const [text, owner, phrases] of [
  [functionMap, functionMapPath, ['feature_id: v3.openai_chat_relay_runtime_integration', 'v3.openai_chat.client_sse_stream']],
  [mainlineMap, mainlineMapPath, ['chain_id: v3.openai_chat_relay.controlled_runtime', 'v3-openai-chat-relay-15']],
  [resourceMap, resourceMapPath, ['resource_id: v3.openai_chat.client_sse_stream', 'allowed_readers: [openai_chat_relay_output_response]']],
  [verificationMap, verificationMapPath, ['feature_id: v3.openai_chat_relay_runtime_integration', 'SSE first client frame is observable before provider terminal']],
  [manifest, manifestPath, ['lifecycle_id: v3.openai_chat_relay.controlled_runtime', 'V3ServerRespOutbound06ClientFrame']],
  [wiki, wikiPath, ['Single lifecycle', 'Body::from_stream', 'Live provider compatibility']],
  [wikiHtml, wikiHtmlPath, ['Canonical Markdown source:', 'V3 OpenAI Chat Relay Controlled Runtime', 'Body::from_stream', 'No fallback']],
]) for (const phrase of phrases) requireText(text, owner, phrase);
requireText(hub, hubPath, 'mod openai_chat_relay_runtime;');
for (const phrase of [
  'execute_v3_openai_chat_relay_runtime_with_default_transport',
  'V3OpenAiChatRelayClientBody::Sse',
  'Body::from_stream(client_stream)',
]) requireText(server, serverPath, phrase);
forbid(openaiServer, serverPath, [
  /client_response[\s\S]{0,200}get\("events"\)/,
  /openai_chat_relay_output_response[\s\S]{0,1200}(?:choices|tool_calls|finish_reason)/,
]);

forbid(runtime, runtimePath, [
  /fallback/i,
  /ResponsesDirect(?:Runtime|11Policy)|execute_v3_responses_direct/i,
  /dynamic[_ -]?hook|libloading|read_dir/i,
  /serde_json::(?:to_value|from_value|to_string)\([^)]*payload/i,
  /into_body_bytes|collect::<Vec<u8>>|bodyText|sse_frames/i,
  /debug_snapshot|metadata_center|resource_handle|continuation_owner/,
]);

if (failures.length) {
  console.error('[verify:v3-openai-chat-relay-runtime-integration] failed');
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}
console.log('[verify:v3-openai-chat-relay-runtime-integration] ok');

function requireText(text, owner, phrase) {
  if (!text.includes(phrase)) failures.push(owner + ': missing ' + phrase);
}
function forbid(text, owner, patterns) {
  for (const pattern of patterns) if (pattern.test(text)) failures.push(owner + ': forbidden ' + pattern);
}
