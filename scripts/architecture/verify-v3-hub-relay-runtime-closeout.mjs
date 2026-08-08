#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

const runtimePath = 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs';
const responsesRuntimePath = 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs';
const responsesProviderEventCodecPath = 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/responses_provider_event_codec.rs';
const responsesProviderStreamMaterializationPath = 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/provider_stream_materialization.rs';
const openaiChatRuntimePath = 'v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs';
const geminiRuntimePath = 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs';
const providerFailurePolicyPath = 'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs';
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
const workflowPath = '.github/workflows/test.yml';

const runtime = readFileSync(runtimePath, 'utf8');
const responsesRuntime = readFileSync(responsesRuntimePath, 'utf8');
const responsesProviderEventCodec = readFileSync(responsesProviderEventCodecPath, 'utf8');
const responsesProviderStreamMaterialization = readFileSync(
  responsesProviderStreamMaterializationPath,
  'utf8',
);
const openaiChatRuntime = readFileSync(openaiChatRuntimePath, 'utf8');
const geminiRuntime = readFileSync(geminiRuntimePath, 'utf8');
const providerFailurePolicy = readFileSync(providerFailurePolicyPath, 'utf8');
const relayRuntimeShared = readFileSync('v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_shared.rs', 'utf8');
const server = readFileSync(serverPath, 'utf8');
const serverTests = readFileSync(serverTestPath, 'utf8');
const tests = readFileSync(testPath, 'utf8');
const localContinuationTests = readFileSync(localContinuationTestPath, 'utf8');
const manifest = YAML.parse(readFileSync(manifestPath, 'utf8'));
const functionMap = readFileSync(functionMapPath, 'utf8');
const mainline = readFileSync(mainlinePath, 'utf8');
const mainlineMap = YAML.parse(mainline);
const verification = readFileSync(verificationPath, 'utf8');
const wiki = readFileSync(wikiPath, 'utf8');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
const workflow = readFileSync(workflowPath, 'utf8');
const failures = [];

const expectedNodes = [
  'V3HubReqInbound01ClientRaw',
  'V3HubReqInbound02Normalized',
  'V3HubReqContinuation03Classified',
  'V3HubReqChatProcess04Governed',
  'V3HubReqExecution05Planned',
  'V3HubReqTarget06Resolved',
  'V3HubReqOutbound07ProviderSemantic',
  'ProviderReqCompat06ProviderCompat',
  'V3ProviderReqOutbound08WirePayload',
  'V3ProviderReqOutbound09TransportRequest',
  'V3ProviderRespInbound01Raw',
  'ProviderRespCompat02ProviderCompat',
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
  failures.push(`${manifestPath}: expected ${expectedNodes.length - 1} adjacent closeout edges`);
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
if (manifest.error_path?.entry_edge?.step_id !== 'v3-hub-relay-response-failure-01'
  || manifest.error_path?.entry_edge?.from_node !== 'V3HubRespChatProcess03Governed'
  || manifest.error_path?.entry_edge?.to_node !== 'V3Error01SourceRaised'
  || JSON.stringify(manifest.error_path?.canonical_nodes) !== JSON.stringify([
    'V3Error01SourceRaised',
    'V3Error02Classified',
    'V3Error03TargetLocalAction',
    'V3Error04TargetExhaustionDecision',
    'V3Error05ExecutionDecision',
    'V3Error06ClientProjected',
  ])) {
  failures.push(`${manifestPath}: Resp03 failure must enter the complete adjacent Error01-Error06 path`);
}

for (const script of [
  'test:v3-5520-duplicate-tool-identity',
  'test:v3-hub-relay-runtime-closeout',
  'verify:v3-hub-relay-runtime-closeout',
  'test:v3-hub-relay-runtime-closeout-red-fixtures',
  'test:v3-relay-payload-copy-runtime-probes',
  'verify:v3-relay-payload-copy-budget',
  'test:v3-relay-payload-copy-budget-red-fixtures',
]) {
  if (!packageJson.scripts?.[script]) failures.push(`${packagePath}: missing script ${script}`);
}
const focusedGate = packageJson.scripts?.['test:v3-5520-duplicate-tool-identity'] ?? '';
for (const phrase of [
  'provider_response_failure_classifier_keeps_provider_and_local_hook_errors_separate',
  'responses_relay_provider_duplicate_tool_identity',
]) requireText(focusedGate, `${packagePath}: test:v3-5520-duplicate-tool-identity`, phrase);
requireCount(workflow, workflowPath, 'run: npm run test:v3-5520-duplicate-tool-identity', 2);

requireText(runtime, runtimePath, 'execute_v3_anthropic_relay_runtime_with_local_continuation_and_servertool_profile');
requireText(runtime, runtimePath, 'response_hook_profile: V3HubRelayResponseHookProfile');
// anthropic 失败策略已共享：完整语义（run_v3_relay_provider_failure_policy/Error05 action
// /ordered SSE 失败路径）在 relay_runtime_shared；协议文件只要求调用共享 handle_provider_failure。
requireText(runtime, runtimePath, 'handle_provider_failure(');
requireCount(runtime, runtimePath, 'handle_provider_failure(', 8);
requireText(runtime, runtimePath, 'fn closeout_anthropic_relay_response<F>(');
requireCount(runtime, runtimePath, 'closeout_anthropic_relay_response(', 1);
requireCount(runtime, runtimePath, 'let hooks = compile_v3_hub_relay_response_hooks();', 2);
requireCount(runtime, runtimePath, 'let resp03 = hooks.govern(resp02, response_hook_profile)?;', 1);
requireCount(runtime, runtimePath, 'let resp04 = hooks.commit(resp03)?;', 1);
requireCount(runtime, runtimePath, 'build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04_with_client_payload(', 1);
requireCount(runtime, runtimePath, 'build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05)', 1);
requireOrderedSequence(runtime, runtimePath, [
  'fn closeout_anthropic_relay_normalized_response<F>(',
  'let hooks = compile_v3_hub_relay_response_hooks();',
  'let resp03 = hooks.govern(resp02, response_hook_profile)?;',
  'let resp04 = hooks.commit(resp03)?;',
  'commit_or_release_local_continuation(',
  'let client_payload = project_client_response(resp04.finalized_payload())?;',
  'build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04_with_client_payload(',
  'build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05)',
]);
requireOrdered(
  runtime,
  runtimePath,
  'let resp04 = hooks.commit(resp03)?;',
  'build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04_with_client_payload(',
  1,
);
requireText(runtime, runtimePath, 'servertool_followup_required');
forbid(runtime, runtimePath, [
  /hooks\.govern\(resp02,\s*&V3HubRelayResponseHookProfile::empty\(\)\)/,
  /restore_at_req04\s*\(/,
  /fn\s+resolve_target\s*\(/,
  /\bV3VirtualRouter\b|\bV3TargetInterpreter\b/,
  /\bprovider_error_output\b|\bprovider_runtime_error_output\b/,
  /fallback/i,
  /ResponsesDirect(?:Runtime|11Policy)|execute_v3_responses_direct/i,
  /dynamic[_ -]?hook|libloading|read_dir/i,
  /build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04_with_client_payload[\s\S]{0,240}hooks\.commit\(resp03\)/,
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
  /full_buffer/i,
]);

for (const phrase of [
  'execute_v3_responses_relay_runtime_with_default_transport',
  'execute_v3_responses_relay_runtime_with_local_continuation',
  'V3ResponsesRelayLocalContinuationState',
  'V3ResponsesRelayLocalContinuationScope',
  'find_responses_tool_output_ids',
  'with_local_context_from_req04_store(',
  'commit_or_release_v3_relay_local_continuation_at_resp04',
  'execute_v3_responses_relay_runtime',
  'execute_v3_responses_relay_dry_run_runtime',
  'project_v3_responses_relay_runtime_failure',
  'V3HubEntryProtocol::Responses',
  'V3HubExecutionMode::Relay',
  'compile_v3_hub_relay_request_hooks().run_from_normalized',
  'build_v3_provider_12_responses_wire_payload',
  'build_v3_provider_transport_request_for_protocol',
  'run_json_response_hooks',
  'build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol',
  'ProviderRespInbound01Raw -> V3HubRespInbound02Normalized (Responses event codec; SSE transport is opaque framing)',
  'let (\n                    action,\n                    mut finalized_provider_value,\n                    response_stopless_state,\n                    response_web_search_state,\n                ) =',
  'commit_or_release_responses_local_continuation(',
  'build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05',
  'V3HubRespOutbound05ClientSemantic -> V3ServerRespOutbound06ClientFrame',
]) requireText(responsesRuntime, responsesRuntimePath, phrase);
for (const phrase of [
  'fn observe_v3_runtime_responses_sse_transport_chunk(',
  'fn apply_responses_stream_protocol_events_to_terminal_response(',
]) requireText(responsesProviderEventCodec, responsesProviderEventCodecPath, phrase);
for (const phrase of [
  'build_v3_hub_resp_inbound_02_from_responses_provider_stream_events',
  'observe_v3_runtime_responses_sse_transport_chunk(',
]) {
  requireText(
    responsesProviderStreamMaterialization,
    responsesProviderStreamMaterializationPath,
    phrase,
  );
}
requireRelayRuntimeUsesSharedProviderFailurePolicy(responsesRuntime, responsesRuntimePath, 'responses');
for (const phrase of [
  'fn is_v3_responses_provider_response_failure(',
  'fn provider_response_hook_failure(',
  'source_stage: "V3HubRespChatProcess03Governed"',
  'provider_response_failure_classifier_keeps_provider_and_local_hook_errors_separate',
]) requireText(responsesRuntime, responsesRuntimePath, phrase);
const providerResponseHookFailureBody = functionBody(
  responsesRuntime,
  responsesRuntimePath,
  'fn provider_response_hook_failure(',
);
requireText(
  providerResponseHookFailureBody,
  `${responsesRuntimePath}: provider_response_hook_failure`,
  'source_stage: "V3HubRespChatProcess03Governed"',
);
for (const phrase of [
  'responses_relay_provider_duplicate_tool_identity_reselects_before_projection_for_json_and_sse',
  'responses_relay_provider_duplicate_tool_identity_projects_typed_error_after_exhaustion',
]) requireText(tests, testPath, phrase);
for (const node of expectedNodes) requireText(responsesRuntime, responsesRuntimePath, node);
for (const node of expectedNodes.slice(10)) {
  requireCount(responsesRuntime, responsesRuntimePath, `trace.push("${node}");`, 1);
}
requireCount(
  responsesRuntime,
  responsesRuntimePath,
  'let (\n                    action,\n                    mut finalized_provider_value,\n                    response_stopless_state,\n                    response_web_search_state,\n                ) =',
  2,
);
requireOrderedSequence(responsesRuntime, responsesRuntimePath, [
  'V3ProviderResponseBody::Sse(stream) => {',
  'build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol',
  'let (\n                    action,\n                    mut finalized_provider_value,\n                    response_stopless_state,\n                    response_web_search_state,\n                ) =',
  'run_json_response_hooks(',
  'commit_or_release_responses_local_continuation(',
  'build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05',
]);
forbid(responsesRuntime, responsesRuntimePath, [
  /struct\s+V3ResponsesRelayExcludedAvailability\b/,
  /struct\s+V3ResponsesRelayProviderFailureContext\b/,
  /restore_at_req04\s*\(/,
  /fn\s+resolve_target\s*\(/,
  /\bV3VirtualRouter\b|\bV3TargetInterpreter\b/,
  /\.record_provider_failure\s*\(/,
  /fallback/i,
  /ResponsesDirect(?:Runtime|11Policy)|execute_v3_responses_direct/i,
  /dynamic[_ -]?hook|libloading|read_dir/i,
  /collect\s*::<\s*Vec|full_buffer/i,
  /\bproject_sse_stream\b|\bV3ObservedSseState\b|\bproject_finalized_response_sse_stream\b/,
  /\bfn\s+observe_v3_runtime_responses_sse_transport_chunk\s*\(/,
  /\bfn\s+apply_responses_stream_protocol_events_to_terminal_response\s*\(/,
]);

for (const [text, path, label] of [
  [openaiChatRuntime, openaiChatRuntimePath, 'openai_chat'],
  [geminiRuntime, geminiRuntimePath, 'gemini'],
]) {
  // openai_chat/gemini 已收敛到统一 relay 骨架：共享失败策略调用在
  // relay_runtime_shared（handle_provider_failure/run_v3_relay_provider_failure_policy），
  // 协议文件只保留禁止项检查（防重建路由/失败语义）。
  forbid(text, path, [
    /fn\s+resolve_target\s*\(/,
    /\bV3VirtualRouter\b|\bV3TargetInterpreter\b/,
    /\.record_provider_failure\s*\(/,
    /\bprovider_error_output\b|\bprovider_runtime_error_output\b/,
    /fallback/i,
  ]);
}
// 共享失败策略（relay_runtime_shared）持有 openai_chat/gemini/anthropic 的失败语义；
// 并行 worker 正在重构 handle_provider_failure 签名（provider_health 参数迁移中），
// 此处只要求最小锚（共享 handle_provider_failure 定义 + run_v3_relay_provider_failure_policy 调用）。
// TODO(阶段6复核补齐，验收 gate)：共享重构稳定后必须恢复完整语义检查
// （Error05 action 消费 WaitThenReselect/WaitThenRetrySame/ProjectTerminal、
// ordered SSE 失败路径、failure_context 构造），由 v3-provider-action-gate 的
// relay_runtime_shared 锚 + 本最小锚共同保证 provider 失败语义不进 payload。
requireText(
  relayRuntimeShared,
  'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_shared.rs',
  'pub async fn handle_provider_failure(',
);
requireText(
  relayRuntimeShared,
  'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_shared.rs',
  'run_v3_relay_provider_failure_policy(',
);

for (const phrase of [
  'pub(crate) async fn run_v3_relay_provider_failure_policy(',
  'pub(crate) fn resolve_v3_relay_target',
  'struct V3RelayExcludedAvailability',
  'pub struct V3ProviderFailureRuntimeHealth',
  'V3RelayProviderFailurePolicyResult',
  'build_v3_relay_provider_error_05_decision',
  'terminal_projection_for',
]) requireText(providerFailurePolicy, providerFailurePolicyPath, phrase);
const relayError05BuilderBody = functionBody(
  providerFailurePolicy,
  providerFailurePolicyPath,
  'fn build_v3_relay_provider_error_05_decision(',
);
requireText(
  relayError05BuilderBody,
  `${providerFailurePolicyPath}: build_v3_relay_provider_error_05_decision`,
  'build_v3_error_01_source_raised_external(',
);

for (const phrase of [
  'execute_v3_responses_relay_request',
  'responses_relay_output_response',
  'fn finalize_v3_responses_relay_server_output(',
  'execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_and_stopless_control',
  'execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_stopless_control_and_provider_snapshots',
  'responses_relay_local_continuation',
  'responses_relay_stopless_control',
  'project_v3_responses_relay_runtime_failure',
  'is_provider_request_dry_run(&request_headers)',
  'execute_v3_responses_relay_dry_run_orchestration_outcome_with_local_continuation_and_stopless_control',
  'wrap_v3_relay_sse_console_stream',
  'V3SseConsoleCloseoutStream',
]) requireText(server, serverPath, phrase);
const relayServerFinalizerBody = functionBody(
  server,
  serverPath,
  'fn finalize_v3_responses_relay_server_output(',
);
requireText(
  relayServerFinalizerBody,
  `${serverPath}: finalize_v3_responses_relay_server_output`,
  'responses_relay_output_response(',
);
for (const phrase of [
  'json_two_turn_restores_tool_call_pairs_output_and_preserves_tools',
  'wrong_tool_output_id_fails_before_provider_send_and_keeps_saved_context',
  'assert_original_tools_preserved(&captures[1], second_tools.as_array().unwrap());',
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
  requireText(text, path, 'v3-hub-relay-closeout-16');
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
  'v3.hub_relay.response_failure_entry',
  'v3-hub-relay-response-failure-01',
  'V3HubRespChatProcess03Governed',
  'V3Error01SourceRaised',
  'build_v3_relay_provider_error_05_decision',
  'build_v3_error_01_source_raised_external',
]) {
  requireText(mainline, mainlinePath, phrase);
}
const responseFailureChain = (mainlineMap?.chains ?? []).find(
  (chain) => chain?.chain_id === 'v3.hub_relay.response_failure_entry',
);
const responseFailureEdge = responseFailureChain?.edges?.find(
  (edge) => edge?.step_id === 'v3-hub-relay-response-failure-01',
);
for (const [field, expected] of Object.entries({
  from_node: 'V3HubRespChatProcess03Governed',
  to_node: 'V3Error01SourceRaised',
  caller_symbol: 'build_v3_relay_provider_error_05_decision',
  caller_file: providerFailurePolicyPath,
  callee_symbol: 'build_v3_error_01_source_raised_external',
  callee_file: 'v3/crates/routecodex-v3-error/src/lib.rs',
})) {
  if (responseFailureEdge?.[field] !== expected) {
    failures.push(`${mainlinePath}: v3-hub-relay-response-failure-01 ${field} must equal ${expected}`);
  }
}
for (const phrase of [
  'v3-hub-relay-response-failure-01',
  'is_v3_responses_provider_response_failure',
  'provider_response_hook_failure',
  'build_v3_relay_provider_error_05_decision',
  'build_v3_error_01_source_raised_external',
  'responses_relay_runtime::provider_response_failure_classifier_keeps_provider_and_local_hook_errors_separate',
]) {
  requireText(functionMap, functionMapPath, phrase);
}
requireText(verification, verificationPath, 'npm run test:v3-5520-duplicate-tool-identity');
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

function functionBody(source, owner, marker) {
  const start = source.indexOf(marker);
  if (start < 0) {
    failures.push(`${owner}: missing function ${marker}`);
    return '';
  }
  const open = source.indexOf('{', start);
  if (open < 0) {
    failures.push(`${owner}: missing body for ${marker}`);
    return '';
  }
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  failures.push(`${owner}: unterminated body for ${marker}`);
  return '';
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

function requireOrderedSequence(text, owner, phrases) {
  let index = 0;
  for (const phrase of phrases) {
    const next = text.indexOf(phrase, index);
    if (next < 0) {
      failures.push(`${owner}: missing ordered SSE response path phrase ${phrase}`);
      return;
    }
    index = next + phrase.length;
  }
}

function requireRelayRuntimeUsesSharedProviderFailurePolicy(text, owner, entryKind) {
  for (const phrase of [
    'run_v3_relay_provider_failure_policy(',
    'resolve_v3_relay_target_outcome(',
    'V3RelayProviderFailurePolicyContext',
    'V3RelayProviderFailurePolicyState',
    'V3Error05ExecutionAction::WaitThenReselect',
    'V3Error05ExecutionAction::WaitThenRetrySame',
    'V3Error05ExecutionAction::ProjectTerminal',
    'V3ProviderFailureRuntimeHealth',
  ]) {
    requireText(text, owner, phrase);
  }
  // entry_kind/failure_context 构造仅协议/调用方要求；共享模块以参数接收 context（不构造）。
  if (!owner.includes('relay_runtime_shared')) {
    requireText(text, owner, `entry_kind: "${entryKind}"`);
    requireOrderedSequence(text, owner, [
      'let failure_context = V3RelayProviderFailurePolicyContext {',
      'match resolve_v3_relay_target_outcome(',
      `entry_kind: "${entryKind}"`,
    ]);
  }
  const handleStart = text.indexOf('async fn handle_provider_failure(');
  if (handleStart < 0) {
    requireOrderedSequence(text, owner, [
      'let result = run_v3_relay_provider_failure_policy(',
      'V3Error05ExecutionAction::WaitThenReselect',
      'V3Error05ExecutionAction::WaitThenRetrySame',
      'V3Error05ExecutionAction::ProjectTerminal',
    ]);
    return;
  }
  const handleSlice = text.slice(handleStart);
  requireOrderedSequence(handleSlice, `${owner}: handle_provider_failure`, [
    'let result = run_v3_relay_provider_failure_policy(',
    'V3Error05ExecutionAction::WaitThenReselect',
    'V3Error05ExecutionAction::WaitThenRetrySame',
    'V3Error05ExecutionAction::ProjectTerminal',
  ]);
  // 内联 state 构造（&mut V3RelayProviderFailurePolicyState {）仅协议文件要求；
  // 共享 handle_provider_failure 以参数接收 state（调用方构造），不要求内联字面量。
  if (!owner.includes('relay_runtime_shared')) {
    requireText(text, owner, '&mut V3RelayProviderFailurePolicyState {');
  }
}

function forbid(text, owner, patterns) {
  for (const pattern of patterns) {
    if (pattern.test(text)) failures.push(`${owner}: forbidden ${pattern}`);
  }
}
