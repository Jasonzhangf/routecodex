#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const runtimePath = 'v3/crates/routecodex-v3-runtime/src/kernel.rs';
const storePath = 'v3/crates/routecodex-v3-runtime/src/remote_continuation.rs';
const responsePath = 'v3/crates/routecodex-v3-runtime/src/shared.rs';
const targetPath = 'v3/crates/routecodex-v3-target/src/lib.rs';
const configTypesPath = 'v3/crates/routecodex-v3-config/src/types.rs';
const configValidatePath = 'v3/crates/routecodex-v3-config/src/validate.rs';
const providerTransportPath = 'v3/crates/routecodex-v3-provider-responses/src/transport.rs';
const serverPath = 'v3/crates/routecodex-v3-server/src/lib.rs';
const testPath = 'v3/crates/routecodex-v3-runtime/tests/responses_direct_remote_continuation_integration.rs';
const configTestPath = 'v3/crates/routecodex-v3-config/tests/config_v3_contract.rs';
const websocketTestPath = 'v3/crates/routecodex-v3-provider-responses/tests/responses_websocket_v2.rs';
const serverTestPath = 'v3/crates/routecodex-v3-server/tests/multi_listener_server.rs';
const designPath = 'docs/goals/v3-responses-direct-remote-continuation-integration-test-design.md';
const planPath = 'docs/goals/v3-responses-direct-remote-continuation-integration-plan.md';
const runtime = readFileSync(runtimePath, 'utf8');
const store = readFileSync(storePath, 'utf8');
const response = readFileSync(responsePath, 'utf8');
const target = readFileSync(targetPath, 'utf8');
const configTypes = readFileSync(configTypesPath, 'utf8');
const configValidate = readFileSync(configValidatePath, 'utf8');
const providerTransport = readFileSync(providerTransportPath, 'utf8');
const server = readFileSync(serverPath, 'utf8');
const tests = readFileSync(testPath, 'utf8');
const configTests = readFileSync(configTestPath, 'utf8');
const websocketTests = readFileSync(websocketTestPath, 'utf8');
const serverTests = readFileSync(serverTestPath, 'utf8');
const design = readFileSync(designPath, 'utf8');
const plan = readFileSync(planPath, 'utf8');
const failures = [];

for (const [owner, text, phrases] of [
  [runtimePath, runtime, [
    'execute_v3_responses_direct_runtime_kernel_core(',
    'static DEFAULT_RESPONSES_TRANSPORT',
    'fn default_responses_transport()',
    'execute_v3_responses_direct_runtime_kernel_with_continuation(',
    '.load_for_req03(response_id, &scope.key, now_epoch_ms)',
    'locator.validate_capability_revision(&current_capability_revision)',
    'target.resolve_exact_provider_model_auth(',
    'trace.push("V3HubReqContinuation03Classified")',
    'trace.push("V3HubReqTarget06Resolved")',
    'trace.push("V3HubRespContinuation04Committed")',
    'let input = V3RemoteContinuationCommitInput::locator_only(locator);',
    'store.rebind_for_resp04(previous_response_id, input)',
    'None => store.commit(input)',
    'release_terminal_failure_locator(',
  ]],
  [storePath, store, [
    'pub fn load_for_req03(',
    'pub fn rebind_for_resp04(',
    'pub fn validate_capability_revision(',
    'CapabilityRevisionMismatch',
    'V3RemoteContinuationOwner::Direct',
  ]],
  [responsePath, response, [
    'V3RemoteContinuationObservation',
    'V3ProviderResponseBody::Sse(stream) => project_sse_stream(stream).await?',
    'SseIncrementalDecoder::new(SseTransportLimits::default())',
    'build_sse_transport_in_01_raw_chunk(&chunk)',
    'observe_sse_frame_remote_continuation(',
    'frame.frame().fields()',
    'observe_json_remote_continuation(&parsed)',
  ]],
  [targetPath, target, ['pub fn resolve_exact_provider_model_auth(']],
  [configTypesPath, configTypes, [
    'pub enum V3ResponsesTransportKind',
    'WebsocketV2',
    'pub websocket_v2_url: Option<String>',
  ]],
  [configValidatePath, configValidate, [
    'let responses = compile_provider_responses(&id, provider.responses, &models)?;',
    'fn compile_provider_responses(',
    'remote_continuation requires responses websocket_v2 transport',
    'HTTP transport cannot declare websocket_v2_url',
    'websocket_v2_url is required for websocket_v2 transport',
  ]],
  [providerTransportPath, providerTransport, [
    'pub enum V3Transport13ResponsesRequest',
    'ProviderResponsesTransport',
    'connect_async(handshake)',
    'event.remove("stream")',
    'event.remove("background")',
    'Value::String("response.create".to_string())',
    'event_type == "error"',
    'event_type != "response.completed"',
    'fn websocket_sse_stream(',
    'OwnedMutexGuard<Option<ResponsesWebSocket>>',
    'stream::unfold(state, |mut state| async move',
    'impl Drop for WebSocketSseState',
    'websocket_event_to_sse',
  ]],
  [serverPath, server, [
    'responses_direct_continuation: Arc<V3ResponsesDirectContinuationState>',
    'build_responses_direct_continuation_scope(',
    'header_text(headers, "session-id")',
    'header_text(headers, "thread-id")',
    'execute_v3_responses_direct_runtime_kernel_with_default_transport_debug_and_continuation(',
  ]],
  [testPath, tests, [
    'json_two_turn_remote_continuation_commits_loads_and_uses_exact_pin_without_router_reentry',
    'sse_two_turn_remote_continuation_commits_and_finishes_on_the_same_exact_pin',
    'missing_locator_scope_mismatch_and_expiry_fail_before_router_or_provider_send',
    'capability_auth_and_provider_availability_drift_fail_at_req06_without_router_or_send',
    'pinned_terminal_provider_failure_uses_error01_06_without_reselection',
    'transport = "websocket_v2"',
  ]],
  [configTestPath, configTests, [
    'remote_continuation_is_bound_to_responses_websocket_v2_transport',
    'HTTP transport cannot declare websocket_v2_url',
    'websocket_v2_url is required',
  ]],
  [websocketTestPath, websocketTests, [
    'websocket_v2_reuses_one_connection_for_exact_incremental_continuation',
    'websocket_v2_binary_events_project_as_equivalent_sse_and_errors_never_fallback',
    'websocket_v2_sse_returns_first_frame_before_terminal_event',
    'previous_response_id',
    'data: [DONE]',
  ]],
  [serverTestPath, serverTests, [
    'responses_direct_server_replays_two_turn_remote_continuation_with_header_scope_and_no_router_reentry',
    'responses_direct_server_replays_two_turn_sse_remote_continuation_without_router_reentry',
    'start_controlled_continuation_websocket',
    'p6_remote_continuation_manifest',
  ]],
  [designPath, design, ['Resp04 commit', 'Req03 load', 'Req06 exact pin', 'Transport-bound continuation matrix']],
  [planPath, plan, ['Provider Responses WebSocket v2 slice', 'Responses WebSocket v2 transport']],
]) {
  for (const phrase of phrases) requireText(text, owner, phrase);
}

const coreDefinitions = runtime.match(/async fn execute_v3_responses_direct_runtime_kernel_core</g) ?? [];
if (coreDefinitions.length !== 1) failures.push(`${runtimePath}: expected one Runtime kernel core, got ${coreDefinitions.length}`);
const projectSseStreamStart = response.indexOf('async fn project_sse_stream(');
const projectSseStreamEnd = response.indexOf('fn observe_sse_remote_continuation_bytes(');
if (projectSseStreamStart < 0 || projectSseStreamEnd < 0 || projectSseStreamEnd <= projectSseStreamStart) {
  failures.push(`${responsePath}: missing project_sse_stream structured observer boundary`);
} else {
  const projectSseStream = response.slice(projectSseStreamStart, projectSseStreamEnd);
  for (const phrase of [
    'build_sse_transport_in_01_raw_chunk(&chunk)',
    'observe_sse_frame_remote_continuation(',
    'frame.frame().fields()',
  ]) {
    requireText(projectSseStream, `${responsePath}: project_sse_stream`, phrase);
  }
}
forbid(runtime, runtimePath, [
  /execute_selected_continuation/,
  /fallback/i,
  /local_materiali[sz]ation|relay_continuation|restore_history|repair_history/i,
  /request_body\s*\[\s*["'](?:provider_id|auth_alias|continuation_owner|capability_revision|routing_group)["']\s*\]/,
]);
forbid(server, serverPath, [
  /body\s*\[\s*["'](?:provider_id|auth_alias|continuation_owner|capability_revision|routing_group)["']\s*\]\s*=/,
  /V3RemoteContinuationStore/,
]);
forbid(response, responsePath, [
  /fallback/i,
  /restore_history|materiali[sz]e_context/i,
  /into_body_bytes\s*\(/,
]);
forbid(providerTransport, providerTransportPath, [
  /fallback/i,
  /local_materiali[sz]ation|relay_continuation|restore_history|repair_history/i,
  /previous_response_id[\s\S]{0,200}null/,
  /let\s+mut\s+sse_frames\s*=\s*Vec::new\s*\(\s*\)/,
  /sse_frames\.push\s*\(/,
  /stream::iter\s*\(\s*sse_frames/,
  /collect\s*::<\s*Vec/,
]);

const resp04 = runtime.indexOf('trace.push("V3HubRespContinuation04Committed")');
const resp15 = runtime.indexOf('trace.push("V3Resp15ClientPayload")');
if (resp04 < 0 || resp15 < 0 || resp04 > resp15) {
  failures.push(`${runtimePath}: Resp04 must precede the single Resp15 response exit`);
}

if (failures.length) {
  console.error('[verify:v3-responses-direct-remote-continuation] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-responses-direct-remote-continuation] ok');

function requireText(text, owner, phrase) {
  if (!text.includes(phrase)) failures.push(`${owner}: missing ${phrase}`);
}
function forbid(text, owner, patterns) {
  for (const pattern of patterns) {
    if (pattern.test(text)) failures.push(`${owner}: forbidden ${pattern}`);
  }
}
