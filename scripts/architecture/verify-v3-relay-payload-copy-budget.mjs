#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const paths = {
  response: 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
  responseCommon: 'v3/crates/routecodex-v3-runtime/src/hub_v1/common.rs',
  responseInbound02: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_inbound_02_normalized.rs',
  responseContinuation04: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs',
  request: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
  hooks: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resource_hooks.rs',
  responsesRelayRuntime: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
  anthropicRelayRuntime: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs',
  anthropicRelayCodec: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime_codec.rs',
  openaiChatRelayRuntime: 'v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs',
  geminiRelayRuntime: 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs',
  providerResponsesTransport: 'v3/crates/routecodex-v3-provider-responses/src/transport.rs',
  providerResponsesWebsocketTests: 'v3/crates/routecodex-v3-provider-responses/tests/responses_websocket_v2.rs',
  providerResponsesWebsocketVerifier: 'scripts/architecture/verify-v3-responses-websocket-v2-transport-hardening.mjs',
  servertoolHooks: 'v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs',
  probes: 'v3/crates/routecodex-v3-runtime/tests/hub_relay_payload_copy_runtime_probes.rs',
  design: 'docs/goals/v3-hub-relay-payload-copy-runtime-probes-test-design.md',
};
const text = Object.fromEntries(
  Object.entries(paths).map(([key, path]) => [key, readFileSync(resolve(root, path), 'utf8')]),
);
const runtime = [
  text.response,
  text.responseCommon,
  text.responseInbound02,
  text.responseContinuation04,
  text.request,
  text.hooks,
  text.servertoolHooks,
  text.responsesRelayRuntime,
  text.anthropicRelayRuntime,
  text.anthropicRelayCodec,
  text.openaiChatRelayRuntime,
  text.geminiRelayRuntime,
].join('\n');
const providerTransport = text.providerResponsesTransport;
const responseContract = [
  text.response,
  text.responseCommon,
  text.responseInbound02,
  text.responseContinuation04,
].join('\n');
const failures = [];

function fail(message) {
  failures.push(message);
}

function requireAll(source, owner, phrases) {
  for (const phrase of phrases) {
    if (!source.includes(phrase)) fail(`${owner}: missing ${phrase}`);
  }
}

function forbid(source, owner, pattern, label) {
  if (pattern.test(source)) fail(`${owner}: forbidden ${label}`);
}

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

requireAll(responseContract, 'V3 split response node contract', [
  'struct V3HubResponsePayload(pub(crate) Arc<Value>);',
  'Arc::ptr_eq(&context.payload, self.previous.previous.provider_payload())',
  'payload: Arc::clone(&finalized_payload),',
  'V3HubTransportIntent::Sse => V3HubResponseNormalizedKind::Sse',
]);
requireAll(text.request, paths.request, [
  'canonical_context: Arc<Value>',
  'restore_local_context_at_req04',
  'Ok(Some(Arc::clone(&local.canonical_context)))',
  'V3HubRelayRequestHookEvent::Req04LocalContextRestored',
]);
requireAll(text.hooks, paths.hooks, [
  "pub struct V3HubCurrentNodeBorrowedView<'node, T>",
  "value: &'node T",
  'borrow_v3_hub_current_node',
]);
requireAll(text.probes, paths.probes, [
  'relay_json_moves_one_business_payload_through_req04',
  'relay_sse_keeps_one_canonical_payload_without_materializing_stream',
  'local_context_is_retained_until_req04_outcome_release',
  'servertool_roundtrip_uses_one_resp04_context_and_restores_before_req04_hook',
  'canonical_context_shares_finalized_payload',
  'drop(lookup)',
  'drop(outcome)',
]);
requireAll(text.design, paths.design, [
  'unbounded `deep_clone`',
  '`serde_json::to_string`/`from_str`',
  'Responses Relay keeps SSE transport-only',
  'Debug/snapshot payloads',
  'hook planning',
  'does not prove live Relay',
]);
requireAll(text.responsesRelayRuntime, paths.responsesRelayRuntime, [
  'build_v3_hub_resp_inbound_02_from_responses_provider_stream_events',
  'ProviderRespInbound01Raw -> V3HubRespInbound02Normalized (Responses event codec; SSE transport is opaque framing)',
  'run_json_response_hooks(',
  'build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05',
  'V3HubRespOutbound05ClientSemantic -> V3ServerRespOutbound06ClientFrame',
  'fn observe_v3_runtime_responses_sse_transport_chunk(',
  'fn apply_responses_stream_protocol_events_to_terminal_response(',
]);
requireAll(text.providerResponsesTransport, paths.providerResponsesTransport, [
  'V3_RESPONSES_WEBSOCKET_PROTOCOL_AGGREGATION_OWNER',
  'V3ProviderResponsesWebSocketSession -> V3ProviderResp14Raw',
  'V3ResponsesWebSocketProtocolAggregate',
  'apply_responses_websocket_protocol_events_to_terminal_response',
]);
requireAll(text.servertoolHooks, paths.servertoolHooks, [
  'fn inject_reasoning_stop_tool_into_additional_tools',
  'additional_tools.tools must be an array; refusing to rebuild original tool JSON path',
  'inject_reasoning_stop_tool_into_array(embedded_tools, "input[].tools")',
  'object.contains_key("tools")',
]);

forbid(runtime, 'Relay runtime source', /\b(?:deep_clone|deepClone)\s*\(/, 'unbounded deep copy');
forbid(
  text.servertoolHooks,
  paths.servertoolHooks,
  /lift_additional_tools_into_provider_tool_surface|collect_additional_tools_from_responses_input|provider_tool_surface_contains_equivalent_tool/,
  'tool declaration shape rebuild helper',
);
forbid(
  runtime,
  'Relay runtime source',
  /serde_json::(?:to_string|to_vec|to_value)[\s\S]{0,240}serde_json::(?:from_str|from_slice|from_value)/,
  'JSON serialization round-trip clone',
);
forbid(
  runtime,
  'Relay runtime source',
  /(?:sse|stream)[^\n]{0,100}(?:collect\s*::<\s*Vec|collect\s*\(|body_text|full_buffer|materiali[sz]e)/i,
  'unowned full SSE materialization',
);
forbid(
  runtime,
  'Relay runtime source',
  /\bSseStreamPassthrough\b/,
  'Relay SSE pass-through body kind',
);
forbid(
  text.responsesRelayRuntime,
  paths.responsesRelayRuntime,
  /\bcollect_v3_responses_relay_sse_response\b/,
  'Responses Relay provider stream collection before response hooks',
);
forbid(
  text.responsesRelayRuntime,
  paths.responsesRelayRuntime,
  /\bcomplete_v3_runtime_sse_materialized_response\b/,
  'Responses Relay terminal response shape materialization',
);
forbid(
  text.responsesRelayRuntime,
  paths.responsesRelayRuntime,
  /\bproject_finalized_response_sse_stream\b/,
  'Responses Relay synthetic SSE re-emission from finalized JSON',
);
forbid(
  text.responsesRelayRuntime,
  paths.responsesRelayRuntime,
  /\bproject_sse_stream\b|\bV3ObservedSseState\b/,
  'Responses Relay raw SSE transport pass-through surface',
);
forbid(
  text.providerResponsesTransport,
  paths.providerResponsesTransport,
  /\bWebSocketJsonEventAccumulator\b|\bapply_to_terminal_response\b/,
  'unowned WebSocket terminal response aggregation surface',
);
if (
  text.responsesRelayRuntime.includes('V3ProviderResponseBody::Sse(stream) => {\n                let client_stream = stream')
  || text.responsesRelayRuntime.includes('run_sse_response_passthrough_hooks')
  || text.responsesRelayRuntime.includes('build_v3_provider_resp_inbound_01_sse_stream_passthrough')
) {
  fail(`${paths.responsesRelayRuntime}: forbidden raw SSE passthrough branch around Hub response hooks`);
}
const providerTerminalOutputReconstructions = countMatches(
  providerTransport,
  /(?:response\.clone\(\)|Value::Object\(\s*source\.clone\(\)\s*\))[\s\S]{0,320}object\.insert\(\s*"output"/g,
);
if (providerTerminalOutputReconstructions > 1) {
  fail(
    `${paths.providerResponsesTransport}: forbidden additional provider transport terminal response output reconstruction outside explicit protocol aggregation owner`,
  );
}
if (providerTerminalOutputReconstructions === 1) {
  requireAll(providerTransport, paths.providerResponsesTransport, [
    'const V3_RESPONSES_WEBSOCKET_PROTOCOL_AGGREGATION_OWNER: &str =',
    'struct V3ResponsesWebSocketProtocolAggregate',
    'function_call_items: BTreeMap<u64, Value>',
    'fn apply_responses_websocket_protocol_events_to_terminal_response(',
    'response.function_call_arguments.delta arrived before function_call output_item',
  ]);
  requireAll(text.providerResponsesWebsocketTests, paths.providerResponsesWebsocketTests, [
    'websocket_v2_json_aggregates_function_call_item_when_terminal_output_is_empty',
    'V3_WS_KEY_ASXS_SHAPE',
  ]);
  requireAll(text.providerResponsesWebsocketVerifier, paths.providerResponsesWebsocketVerifier, [
    'same-stream WebSocket event aggregation',
    'struct V3ResponsesWebSocketProtocolAggregate',
    'websocket_v2_json_aggregates_function_call_item_when_terminal_output_is_empty',
  ]);
}
forbid(
  runtime,
  'Relay runtime source',
  /(?:continuation|request|response|business)[^\n]{0,100}(?:truth|payload)[^\n]{0,100}(?:debug_snapshot|snapshot_payload)|(?:debug_snapshot|snapshot_payload)[^\n]{0,100}(?:truth|payload)/i,
  'Debug/snapshot truth substitution',
);
forbid(
  text.hooks,
  paths.hooks,
  /(?:HookPlan|HookPlanning|hook_plan)[\s\S]{0,240}(?:retained_payload|owned_payload|payload\s*:\s*(?:Value|Arc\s*<\s*Value)|\.clone\s*\(\))/,
  'hook planning payload retention or clone',
);
forbid(
  text.request,
  paths.request,
  /(?:payload|canonical_context)\s*\.clone\s*\(\)/,
  'full request/context clone',
);
forbid(
  responseContract,
  'V3 split response node contract',
  /(?:payload|canonical_context)\s*\.clone\s*\(\)/,
  'full response/context clone',
);

const maps = [
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-verification-map.yml',
];
for (const path of maps) {
  requireAll(readFileSync(resolve(root, path), 'utf8'), path, [
    'v3.hub_relay_payload_copy_runtime_probes',
    'v3-hub-relay-copy-probe-01',
    'v3-hub-relay-copy-probe-02',
    'v3-hub-relay-copy-probe-03',
    'v3-hub-relay-copy-probe-04',
  ]);
}

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
for (const script of [
  'test:v3-relay-payload-copy-runtime-probes',
  'verify:v3-relay-payload-copy-budget',
  'test:v3-relay-payload-copy-budget-red-fixtures',
]) {
  if (!packageJson.scripts?.[script]) fail(`package.json: missing script ${script}`);
}

if (failures.length > 0) {
  console.error('[verify:v3-relay-payload-copy-budget] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:v3-relay-payload-copy-budget] ok');
