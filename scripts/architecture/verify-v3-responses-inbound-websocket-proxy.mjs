#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const files = {
  server: 'v3/crates/routecodex-v3-server/src/lib.rs',
  tests: 'v3/crates/routecodex-v3-server/tests/multi_listener_server.rs',
  serverCargo: 'v3/crates/routecodex-v3-server/Cargo.toml',
  providerTransport: 'v3/crates/routecodex-v3-provider-responses/src/transport.rs',
  runtime: 'v3/crates/routecodex-v3-runtime/src/kernel.rs',
  functionMap: 'docs/architecture/v3-function-map.yml',
  mainlineMap: 'docs/architecture/v3-mainline-call-map.yml',
  resourceMap: 'docs/architecture/v3-resource-operation-map.yml',
  verificationMap: 'docs/architecture/v3-verification-map.yml',
  manifest: 'docs/architecture/manifests/v3.responses_inbound_websocket_proxy.mainline.yml',
  wiki: 'docs/architecture/wiki/v3-responses-inbound-websocket-proxy.md',
  packageJson: 'package.json',
};
const text = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, readFileSync(file, 'utf8')]));
const packageJson = JSON.parse(text.packageJson);
const failures = [];

function requireText(owner, body, phrase) {
  if (!body.includes(phrase)) failures.push(owner + ': missing ' + phrase);
}
function forbid(owner, body, patterns) {
  for (const pattern of patterns) {
    if (pattern.test(body)) failures.push(owner + ': forbidden pattern ' + pattern);
  }
}

for (const phrase of [
  '.route(\n            "/v1/responses",\n            post(pending_endpoint).get(responses_websocket_endpoint),\n        )',
  'async fn responses_websocket_endpoint(',
  'OpenAI-Beta: responses_websockets=2026-02-06 is required for /v1/responses WebSocket',
  'async fn responses_websocket_session(',
  'fn responses_websocket_create_payload(',
  'unsupported client WebSocket event type',
  'expected response.create',
  'response.create must be a flat event; nested response payload is unsupported',
  'execute_responses_direct_server_frame(',
  'async fn execute_responses_relay_websocket_output(',
  'send_responses_relay_websocket_output(',
  'execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_and_stopless_control(',
  'execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug(',
  'send_responses_websocket_sse_stream(',
  'SseIncrementalDecoder::new(SseTransportLimits::default())',
  'client_message = socket.next() =>',
  'response.create is already in flight',
  'build_v3_sse_transport_in_01_raw_chunk(&chunk)',
  'runtime byte frame is not valid JSON',
  'runtime SSE decode failed',
  'runtime SSE stream did not terminate cleanly',
  'invalid_client_event',
]) requireText(files.server, text.server, phrase);

for (const phrase of [
  'responses_inbound_websocket_requires_beta_upgrade_and_handles_ping',
  'responses_inbound_websocket_projects_json_completed_event_and_enters_runtime',
  'responses_inbound_websocket_accepts_binary_response_create_payload',
  'responses_inbound_websocket_projects_sse_runtime_events_as_websocket_frames',
  'responses_inbound_websocket_rejects_malformed_client_event_without_provider_send',
  'responses_inbound_websocket_replays_two_turn_tool_continuation_on_same_socket',
  'responses_inbound_websocket_scope_mismatch_fails_before_provider_send',
  'responses_inbound_websocket_projects_provider_error_as_websocket_error_without_http_fallback',
  'responses_inbound_websocket_client_disconnect_drops_incremental_runtime_stream',
  'responses_relay_websocket_uses_hub_relay_runtime_instead_of_direct_runtime',
  'connect_async(request)',
  'responses_websockets=2026-02-06',
  'assert_control_fields_absent(&provider_event.body)',
  'captures.try_recv().is_err()',
]) requireText(files.tests, text.tests, phrase);

for (const phrase of [
  'axum = { workspace = true, features = ["ws"] }',
]) requireText(files.serverCargo, text.serverCargo, phrase);

for (const phrase of [
  'feature_id: v3.responses_inbound_websocket_proxy',
  'routecodex-v3-server',
  'responses_websocket_endpoint',
  'responses_websocket_create_payload',
  'execute_responses_direct_server_frame',
  'execute_responses_relay_websocket_output',
  'send_responses_relay_websocket_output',
  'send_responses_websocket_sse_stream',
  'v3.responses.inbound_websocket_client_connection',
  'v3.responses.inbound_websocket_frame_projection',
]) requireText(files.functionMap, text.functionMap, phrase);

for (const phrase of [
  'chain_id: v3.responses.inbound_websocket_proxy',
  'step_id: v3-inws-01',
  'step_id: v3-inws-02',
  'step_id: v3-inws-03',
  'step_id: v3-inws-04',
  'owner_feature_id: v3.responses_inbound_websocket_proxy',
]) requireText(files.mainlineMap, text.mainlineMap, phrase);

for (const phrase of [
  'resource_id: v3.responses.inbound_websocket_client_connection',
  'resource_id: v3.responses.inbound_websocket_frame_projection',
  'owner_feature_id: v3.responses_inbound_websocket_proxy',
  'forbidden_writers: [routecodex-v3-provider-responses, routecodex-v3-runtime, routecodex-v3-virtual-router, routecodex-v3-target]',
]) requireText(files.resourceMap, text.resourceMap, phrase);

for (const phrase of [
  'feature_id: v3.responses_inbound_websocket_proxy',
  'controlled JSON WebSocket response.create enters the configured Responses Runtime',
  'malformed client WebSocket event fails before provider send',
  'npm run test:v3-responses-inbound-websocket-proxy',
  'npm run verify:v3-responses-inbound-websocket-proxy',
]) requireText(files.verificationMap, text.verificationMap, phrase);

for (const phrase of [
  'lifecycle_id: v3.responses.inbound_websocket_proxy',
  'owner_feature_id: v3.responses_inbound_websocket_proxy',
  'V3ResponsesInboundWs01ClientUpgrade',
  'V3ResponsesInboundWs04ClientEventProjected',
]) requireText(files.manifest, text.manifest, phrase);

for (const phrase of [
  '# V3 Responses inbound WebSocket proxy',
  'Server owns only the client WebSocket upgrade and frame projection shell.',
  'Provider WebSocket state remains owned by v3.responses_websocket_v2_transport_hardening.',
]) requireText(files.wiki, text.wiki, phrase);

for (const script of [
  'test:v3-responses-inbound-websocket-proxy',
  'verify:v3-responses-inbound-websocket-proxy',
  'test:v3-responses-inbound-websocket-proxy-red-fixtures',
]) {
  if (!packageJson.scripts?.[script]) failures.push(files.packageJson + ': missing script ' + script);
}

const wsStart = text.server.indexOf('async fn responses_websocket_endpoint(');
const wsEnd = text.server.indexOf('fn pending_binding_output_response(');
if (wsStart < 0 || wsEnd <= wsStart) {
  failures.push(files.server + ': missing WebSocket owner boundary');
} else {
  const wsSection = text.server.slice(wsStart, wsEnd);
  forbid(files.server + ': WebSocket section', wsSection, [
    /connect_async\s*\(/,
    /WebSocketStream</,
    /SharedResponsesWebSocket/,
    /websocket_sessions/,
    /reqwest::/,
    /HTTP fallback|http_fallback|retry_http/i,
    /restore_history|repair_history|local_materiali[sz]ation/i,
    /collect\s*::<\s*Vec/,
    /let\s+mut\s+(?:events|frames|chunks|responses)\s*=\s*Vec::new/,
  ]);
}


const clientSocketPolls = text.server.match(/client_message = socket\.next\(\) =>/g) ?? [];
if (clientSocketPolls.length !== 2) {
  failures.push(files.server + ': expected Direct and Relay WebSocket stream client disconnect polling, got ' + clientSocketPolls.length);
}
const runtimeSseDecodeGuards = text.server.match(/runtime SSE decode failed/g) ?? [];
if (runtimeSseDecodeGuards.length !== 2) {
  failures.push(files.server + ': expected Direct and Relay runtime SSE decode guards, got ' + runtimeSseDecodeGuards.length);
}

const directRuntimeCalls = text.server.match(/execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug\(/g) ?? [];
if (directRuntimeCalls.length !== 1) {
  failures.push(files.server + ': expected one existing Direct Runtime entry call, got ' + directRuntimeCalls.length);
}
const relayRuntimeCalls = text.server.match(/execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_and_stopless_control\(/g) ?? [];
if (relayRuntimeCalls.length !== 2) {
  failures.push(files.server + ': expected HTTP plus WebSocket Relay Runtime entry calls, got ' + relayRuntimeCalls.length);
}

forbid(files.server, text.server, [
  /routecodex_v3_provider_responses/,
  /V3ProviderResponsesWebSocketSession/,
  /ProviderResponsesTransport::send_websocket_v2/,
]);
forbid(files.runtime, text.runtime, [
  /responses_websocket_endpoint/,
  /responses_websocket_session/,
]);
for (const phrase of [
  'async fn send_websocket_v2',
  'websocket_sessions: Arc<Mutex<BTreeMap<String, SharedResponsesWebSocket>>>',
]) requireText(files.providerTransport, text.providerTransport, phrase);

if (failures.length) {
  console.error('[verify:v3-responses-inbound-websocket-proxy] failed');
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}
console.log('[verify:v3-responses-inbound-websocket-proxy] ok');
