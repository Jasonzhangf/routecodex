#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { attachProviderActionGateHelpers } from './v3-provider-action-gate-lib.mjs';

const v3Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = process.env.ROUTECODEX_V3_SOURCE_ROOT
  ? path.resolve(process.env.ROUTECODEX_V3_SOURCE_ROOT)
  : path.resolve(v3Root, '..');
const failures = [];
const files = {
  policy: 'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs',
  policyHealth: 'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy_health.rs',
  policyTests: 'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy/tests.rs',
  error: 'v3/crates/routecodex-v3-error/src/lib.rs',
  direct: 'v3/crates/routecodex-v3-runtime/src/kernel.rs',
  directHelpers: 'v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers.rs',
  directUnitTests: 'v3/crates/routecodex-v3-runtime/src/kernel/tests.rs',
  protocolModeLockTests: 'v3/crates/routecodex-v3-runtime/src/kernel/tests/protocol_mode_lock.rs',
  directExactPinTests: 'v3/crates/routecodex-v3-runtime/src/kernel/tests/exact_pin.rs',
  directSse: 'v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers_stream.rs',
  providerSseJsonCodec: 'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_sse_json_codec.rs',
  providerResponsesEventClassification:
    'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_responses_event_classification.rs',
  responses: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
  responsesInner: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs',
  responsesFailures: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_failures.rs',
  responsesRelayUnitTests: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_tests_extra.rs',
  serverConsole: 'v3/crates/routecodex-v3-server/src/console/impl_bulk.rs',
  responsesMaterializer: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/provider_stream_materialization.rs',
  responsesCodec: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/responses_provider_event_codec.rs',
  openaiChat: 'v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs',
  anthropic: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs',
  gemini: 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs',
  relayShared: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_shared.rs',
  relayCore: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_core.rs',
  server: 'v3/crates/routecodex-v3-server/src/lib.rs',
  serverTests: 'v3/crates/routecodex-v3-server/src/tests/mod.rs',
  publicIsolationTests: 'v3/crates/routecodex-v3-server/tests/support/pool_empty_recovery_blackbox.rs',
  openaiChatTests: 'v3/crates/routecodex-v3-runtime/tests/openai_chat_relay_runtime_integration.rs',
  geminiTests: 'v3/crates/routecodex-v3-runtime/tests/gemini_relay_runtime_integration.rs',
  directSseTests: 'v3/crates/routecodex-v3-runtime/tests/responses_direct_tool_passthrough.rs',
  responsesRelayTests: 'v3/crates/routecodex-v3-runtime/tests/hub_relay_runtime_closeout.rs',
  directTests: 'v3/crates/routecodex-v3-runtime/tests/responses_direct_tool_passthrough.rs',
  errorTests: 'v3/crates/routecodex-v3-error/tests/typed_error05_terminal_contract.rs',
  functionMap: 'docs/architecture/v3-function-map.yml',
  resourceMap: 'docs/architecture/v3-resource-operation-map.yml',
  mainlineMap: 'docs/architecture/v3-mainline-call-map.yml',
  verificationMap: 'docs/architecture/v3-verification-map.yml',
  manifest: 'docs/architecture/manifests/v3.provider_action_gate.mainline.yml',
  wiki: 'docs/architecture/wiki/v3-provider-action-gate.md',
  plan: 'docs/goals/direct-relay-cross-request-error-storm-control-plan.md',
  packageJson: 'v3/package.json',
  workflow: '.github/workflows/test.yml',
};
const {
  abs,
  assertCallerInvokesCallee,
  assertExactStrings,
  assertIncludes,
  assertRustTest,
  assertWikiEdge,
  asArray,
  escapeRegExp,
  extractSingleMermaidBlock,
  extractWikiStepIds,
  findFunctionBody,
  maskCommentsAndStrings,
  parseYaml,
  read,
  requireOccurrenceCount,
  requireText,
  requiredV3Edges,
  simpleSymbol,
  stringSet,
} = attachProviderActionGateHelpers({ root, failures, files });




function verifyEdgeContract({ mapDoc, manifestDoc, chainId, requiredEdges, mapRel, manifestRel, v3 }) {
  const chain = asArray(mapDoc?.chains).find((row) => row?.chain_id === chainId);
  if (!chain) {
    failures.push(`${mapRel}: missing required chain ${chainId}`);
    return;
  }
  const mapEdges = asArray(chain.edges);
  if (mapEdges.length !== requiredEdges.length) {
    failures.push(`${mapRel}: ${chainId} must contain exactly ${requiredEdges.length} edges`);
  }
  const duplicateMapIds = mapEdges
    .map((edge) => edge?.step_id)
    .filter((stepId, index, all) => all.indexOf(stepId) !== index);
  if (duplicateMapIds.length > 0) {
    failures.push(`${mapRel}: duplicate edge IDs: ${[...new Set(duplicateMapIds)].join(', ')}`);
  }
  const mapIds = new Set(mapEdges.map((edge) => edge?.step_id));
  const requiredIds = new Set(requiredEdges.map((edge) => edge.step_id));
  for (const stepId of requiredIds) {
    if (!mapIds.has(stepId)) failures.push(`${mapRel}: missing required edge ${stepId}`);
  }
  for (const stepId of mapIds) {
    if (!requiredIds.has(stepId)) failures.push(`${mapRel}: unexpected edge ${stepId} in ${chainId}`);
  }
  const manifestEdges = asArray(manifestDoc?.edges);
  if (manifestEdges.length !== requiredEdges.length) {
    failures.push(`${manifestRel}: must contain exactly ${requiredEdges.length} edges`);
  }
  const duplicateManifestIds = manifestEdges
    .map((edge) => edge?.step_id)
    .filter((stepId, index, all) => all.indexOf(stepId) !== index);
  if (duplicateManifestIds.length > 0) {
    failures.push(
      `${manifestRel}: duplicate edge IDs: ${[...new Set(duplicateManifestIds)].join(', ')}`,
    );
  }
  const manifestIds = new Set(manifestEdges.map((edge) => edge?.step_id));
  for (const stepId of requiredIds) {
    if (!manifestIds.has(stepId)) failures.push(`${manifestRel}: missing required edge ${stepId}`);
  }
  for (const stepId of manifestIds) {
    if (!requiredIds.has(stepId)) failures.push(`${manifestRel}: unexpected edge ${stepId}`);
  }

  for (const required of requiredEdges) {
    const mapEdge = mapEdges.find((edge) => edge?.step_id === required.step_id);
    const manifestEdge = manifestEdges.find((edge) => edge?.step_id === required.step_id);
    if (!mapEdge || !manifestEdge) continue;
    for (const field of [
      'caller_symbol',
      'caller_file',
      'callee_symbol',
      'callee_file',
      'status',
      'owner_feature_id',
    ]) {
      if (mapEdge[field] !== required[field]) {
        failures.push(`${mapRel}: ${required.step_id}.${field} must equal ${required[field]}`);
      }
      if (manifestEdge[field] !== mapEdge[field]) {
        failures.push(`${manifestRel}: ${required.step_id}.${field} is out of sync with ${mapRel}`);
      }
    }
    const mapFrom = mapEdge.from_node;
    const mapTo = mapEdge.to_node;
    const manifestFrom = v3 ? manifestEdge.from : manifestEdge.from_node;
    const manifestTo = v3 ? manifestEdge.to : manifestEdge.to_node;
    if (mapFrom !== required.from_node || mapTo !== required.to_node) {
      failures.push(
        `${mapRel}: ${required.step_id} endpoints must be ${required.from_node} -> ${required.to_node}`,
      );
    }
    if (manifestFrom !== mapFrom || manifestTo !== mapTo) {
      failures.push(`${manifestRel}: ${required.step_id} endpoints are out of sync with ${mapRel}`);
    }
    assertCallerInvokesCallee(required);
  }
}

for (const rel of Object.values(files)) {
  if (!fs.existsSync(abs(rel))) failures.push(`${rel}: missing required file`);
}
const text = Object.fromEntries(Object.entries(files).map(([key, rel]) => [key, read(rel)]));
if (/fn\s+try_admit_candidate_rate_limit\s*\(/u.test(text.policyHealth)) {
  failures.push(`${files.policyHealth}: fresh candidate selection must not use a 429 admission wrapper`);
}
// 并行 worker 拆分：responses relay 执行函数迁至 responses_relay_runtime_inner.rs，
// gate 语义（provider 动作门禁/恢复）同时覆盖主文件与 inner 执行体。
text.responses = text.responses + '\n' + text.responsesInner;

for (const token of [
  '"ProviderReqCompat06ProviderCompat"',
  '"provider_request_compat_error"',
  '"V3ProviderReqOutbound08WirePayload"',
  '"provider_request_wire_error"',
]) {
  requireText(text.responsesFailures, files.responsesFailures, token);
}
const responsesRelayRequestBody = findFunctionBody(
  text.responses,
  'execute_v3_responses_relay_runtime_inner_with_refill',
  files.responses,
);
for (const forbidden of [
  'provider_compat_error_is_target_protocol_incompatible',
  'target_protocol_incompatible_candidates',
  'last_target_protocol_incompatible_error',
]) {
  if (responsesRelayRequestBody.includes(forbidden)) {
    failures.push(`${files.responses}: ProviderReqCompat06ProviderCompat must not switch provider through ${forbidden}`);
  }
}
assertCallerInvokesCallee({
  step_id: 'v3-provider-action-gate-responses-policy-ingress',
  caller_symbol: 'handle_v3_responses_relay_provider_failure',
  caller_file: files.responses,
  callee_symbol: 'run_v3_relay_provider_failure_policy_with_response_source',
  callee_file: files.policy,
});
if (fs.existsSync(abs('v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs'))) {
  failures.push('retired provider action admission gate must not be restored');
}

for (const token of [
  'pub struct V3Error05RecoveryAdmissionWitness',
  'pub enum V3Error05ExecutionAction',
  'WaitThenReselect',
  'ProjectTerminal',
  'pub struct V3Error05TerminalDecision',
  'pub fn try_into_terminal',
  'terminal: V3Error05TerminalDecision',
]) {
  requireText(text.error, files.error, token);
}
requireOccurrenceCount(
  text.error,
  files.error,
  'terminal: V3Error05TerminalDecision',
  2,
);
if (
  !/pub\s+struct\s+V3Error05RecoveryAdmissionWitness\s*\{[^}]*\bgeneration:\s*u64,/u
    .test(text.error)
) {
  failures.push(
    `${files.error}: V3Error05RecoveryAdmissionWitness missing generation: u64`,
  );
}
for (const testName of [
  'classifier_failure_preserves_its_own_error01_stage_and_code',
  'route_plan_failure_preserves_its_own_error01_stage_and_code',
  'candidate_expansion_failure_preserves_its_own_error01_stage_and_code',
  'unavailable_candidate_is_exhaustion_not_runtime_failure',
  'target_resolution_failure_projects_itself_instead_of_prior_provider_429',
]) {
  assertRustTest(text.policyTests, files.policyTests, testName);
}
if (/pub\s+struct\s+V3Error05TerminalDecision\s*\{\s*pub/gu.test(text.error)) {
  failures.push(`${files.error}: terminal Error05 wrapper must not expose constructible fields`);
}
if (
  !/pub\s+fn\s+build_v3_error_06_client_projected_from_v3_error_05\s*\(\s*terminal:\s*V3Error05TerminalDecision,?\s*\)/u
    .test(text.error)
) {
  failures.push(
    `${files.error}: Error06 builder must accept only V3Error05TerminalDecision`,
  );
}

for (const [name, source, rel] of [
  ['Direct', text.direct, files.direct],
  ['Responses Relay', text.responses, files.responses],
  ['Anthropic Relay', text.anthropic, files.anthropic],
]) {
  if (!source.includes('V3Error05ExecutionAction')) {
    failures.push(`${rel}: ${name} must consume typed Error05 actions`);
  }
  if (source.includes('pending_provider_action_gate')) {
    failures.push(`${rel}: ${name} must not retain bool-only provider action recovery state`);
  }
  if (source.includes('wait_for_selected_provider_action')) {
    failures.push(`${rel}: ${name} must not select a recovery lane by latest routing-group state`);
  }
}
// openai_chat/gemini 已收敛到统一 relay 骨架：完整 provider action gate 语义
// 分布在骨架（recovery 等待/重试循环）与共享失败策略（Error05 action 消费）中。
{
  const source = `${text.relayCore}\n${text.relayShared}`;
  const rel = `${files.relayCore} + ${files.relayShared}`;
  const name = 'Relay Skeleton';
  if (!source.includes('V3Error05ExecutionAction')) {
    failures.push(`${rel}: ${name} must consume typed Error05 actions`);
  }
  if (source.includes('pending_provider_action_gate')) {
    failures.push(`${rel}: ${name} must not retain bool-only provider action recovery state`);
  }
  if (source.includes('wait_for_selected_provider_action')) {
    failures.push(`${rel}: ${name} must not select a recovery lane by latest routing-group state`);
  }
}
requireText(text.directSse, files.directSse, 'classify_v3_provider_sse_json_data(');
requireText(text.directSse, files.directSse, 'V3HubProviderWireProtocol::Responses,');
if (/event\s*==\s*["']response\./u.test(text.directSse)) {
  failures.push(
    `${files.directSse}: SSE event metadata must not be used as provider semantic source`,
  );
}
if (text.directHelpers.includes('wrap_direct_sse_stopless_control_stream')) {
  failures.push(`${files.directHelpers}: removed SSE stopless stream wrapper must not reappear`);
}
requireText(text.policy, files.policy, 'V3RelayProviderTargetResolution::Exhausted');
const relayFailurePolicy = findFunctionBody(
  text.policy,
  'run_v3_relay_provider_failure_policy_with_response_source_inner',
  files.policy,
);
const targetResolutionFailure = relayFailurePolicy.match(
  /V3RelayProviderTargetResolution::Failed\(source\)\s*=>\s*\{\s*let resolution_message = source\.message\.clone\(\);[\s\S]{0,1400}?run_v3_error_02_to_05_decision_operators\(\s*source_projection,\s*source,/u,
);
if (!targetResolutionFailure) {
  failures.push(
    `${files.policy}: target-resolution source errors must not be swallowed as provider-pool exhaustion`,
  );
}
requireText(
  text.responses,
  files.responses,
  'Some("response.completed") => Some("completed".to_string()),',
);
requireText(
  text.responsesCodec,
  files.responsesCodec,
  'V3ResponsesSseTerminalState::Completed',
);
requireText(text.responsesCodec, files.responsesCodec, '| "response.done"');
requireText(
  `${text.providerSseJsonCodec}\n${text.providerResponsesEventClassification}`,
  `${files.providerSseJsonCodec} + ${files.providerResponsesEventClassification}`,
  'if matches!(event_type, "response.completed" | "response.incomplete") {',
);
for (const forbidden of [
  'Some("response.completed" | "response.done")',
  'Some("response.completed" | "response.done" | "response.requires_action")',
]) {
  if (text.responses.includes(forbidden) || text.responsesCodec.includes(forbidden)) {
    failures.push(
      `${files.responses} + ${files.responsesCodec}: provider response.done/response.requires_action must not satisfy the response.completed terminal contract`,
    );
  }
}
if (text.providerSseJsonCodec.includes('matches!(event_type, "response.completed" | "response.done")')) {
  failures.push(
    `${files.providerSseJsonCodec}: provider response.done must not satisfy the response.completed terminal contract`,
  );
}
requireText(
  text.direct,
  files.direct,
  'execute_v3_responses_direct_runtime_kernel_core_resident',
);
requireText(
  text.directSse,
  files.directSse,
  'collect_direct_sse_attempt_after_terminal',
);
requireText(
  text.direct,
  files.direct,
  'V3AttemptSuccessReceipt::from_sealed_sse_attempt',
);
for (const forbidden of [
  'wrap_direct_sse_provider_handoff_stream',
  'execute_v3_responses_direct_runtime_kernel_core_with_handoff_budget',
]) {
  if (text.direct.includes(forbidden) || text.directSse.includes(forbidden)) {
    failures.push(`${files.direct} + ${files.directSse}: forbidden removed Direct lifecycle symbol ${forbidden}`);
  }
}
for (const [name, source, rel] of [
  ['Anthropic Relay', text.anthropic, files.anthropic],
]) {
  requireText(source, rel, 'provider_request_failure');
  requireText(source, rel, 'handle_provider_request_failure');
  if (/build_provider_req_compat_06_from_v3_hub_req_outbound_07\(req07\)\?/u.test(source)) {
    failures.push(`${rel}: ${name} provider compat failure bypasses typed Error05`);
  }
}
// openai_chat/gemini 已收敛到统一 relay 骨架：request 失败语义（provider_request_failure /
// handle_provider_request_failure）在骨架内，由骨架统一持有。
{
  const source = text.relayCore;
  const rel = files.relayCore;
  requireText(source, rel, 'provider_request_failure');
  requireText(source, rel, 'handle_provider_request_failure');
  if (/build_provider_req_compat_06_from_v3_hub_req_outbound_07\(req07\)\?/u.test(source)) {
    failures.push(`${rel}: Relay Skeleton provider compat failure bypasses typed Error05`);
  }
}
for (const token of [
  'project_v3_client_disconnect',
  'record_real_provider_error_for_interface',
  'last_candidate_terminal',
  'build_v3_relay_provider_error_05_decision',
  'terminal_projection_for',
  'provider_runtime_failure_stage',
]) {
  requireText(text.policy, files.policy, token);
}
for (const forbidden of [
  'V3RelayProviderFailureDecision',
  'V3DirectProviderFailureDecision',
  'retry_delay_ms',
  'default_floor_delay_ms_for_retry',
  'V3_PROVIDER_FAILURE_BACKOFF_DELAY_MS',
  'target_local_reselect")',
]) {
  const production = [
    text.policy,
    text.direct,
    text.directHelpers,
    text.responses,
    text.openaiChat,
    text.anthropic,
    text.gemini,
  ].join('\n');
  if (production.includes(forbidden)) failures.push(`V3 provider action path contains forbidden legacy token ${forbidden}`);
}

assertRustTest(text.policyTests, files.policyTests, 'issue44cc3af_error_return_holds_are_independent');
for (const testName of [
  'issue44cc3af_error_hold_does_not_block_same_identity_direct',
  'issue44cc3af_error_hold_does_not_block_same_identity_relay',
  'issue44cc3af_429_hold_does_not_block_same_identity_direct',
  'issue44cc3af_429_hold_does_not_block_same_identity_relay',
]) {
  assertRustTest(text.publicIsolationTests, files.publicIsolationTests, testName);
}
for (const token of [
  'sse_provider_attempt_is_not_committed_before_provider_terminal',
  'sse_done_before_terminal_fails_and_terminal_without_done_succeeds',
  'terminal_sse_attempt_commits_after_eof_and_releases_a_fresh_request',
]) {
  assertRustTest(text.openaiChatTests, files.openaiChatTests, token);
}
for (const testName of [
  'sse_client_disconnect_is_health_neutral_and_never_enters_action_wait',
  'validated_terminal_sse_releases_action_lane_for_a_fresh_request',
  'broker_terminal_validation_does_not_block_another_request',
]) {
  assertRustTest(text.geminiTests, files.geminiTests, testName);
}
assertRustTest(
  text.openaiChatTests,
  files.openaiChatTests,
  'provider_error_enters_error01_06_without_success_projection',
);
assertRustTest(
  text.geminiTests,
  files.geminiTests,
  'recoverable_provider_429_stays_pending_past_residence_without_projection',
);
assertRustTest(
  text.responsesRelayTests,
  files.responsesRelayTests,
  'responses_relay_terminal_missing_fails_explicitly_but_fresh_request_bypasses_recovery',
);
assertRustTest(
  text.responsesRelayTests,
  files.responsesRelayTests,
  'responses_relay_content_filter_incomplete_preserves_output_without_reselect',
);
for (const token of [
  'provider_sse_done_without_completed_is_terminal_missing',
  'provider_sse_requires_action_without_completed_is_terminal_missing',
]) {
  assertRustTest(text.responsesRelayUnitTests, files.responsesRelayUnitTests, token);
}
for (const token of [
  'malformed_sse_attempt_never_commits_partial_bytes_and_fresh_request_remains_independent',
  'failed_terminal_sse_attempt_never_commits_partial_bytes_and_exhausts_to_error06',
  'terminal_sse_success_seals_replay_without_blocking_a_fresh_request',
]) {
  assertRustTest(text.directSseTests, files.directSseTests, token);
}
assertRustTest(
  text.directTests,
  files.directTests,
  'direct_client_disconnect_is_health_neutral_and_never_enters_action_wait',
);
assertRustTest(
  text.directUnitTests,
  files.directUnitTests,
  'normal_direct_request_does_not_consume_unrelated_provider_failure_gate',
);
assertRustTest(
  text.protocolModeLockTests,
  files.protocolModeLockTests,
  'direct_generic_provider_http_400_terminal_exhaustion_has_no_health_or_wait',
);
requireText(
  text.directHelpers,
  files.directHelpers,
  'if matches!(source.source_kind, V3ErrorSourceKind::ClientDisconnect)',
);
requireText(
  text.directExactPinTests,
  files.directExactPinTests,
  'previous_response_id_is_rejected_without_router_or_provider_reentry',
);
for (const token of [
  'provider_failure_with_route_capacity_is_typed_nonterminal_error05',
  'provider_failure_never_uses_same_provider_budget',
  'provider_failure_projects_only_with_route_and_default_exhaustion_proof',
]) {
  assertRustTest(text.errorTests, files.errorTests, token);
}
requireText(
  text.error,
  files.error,
  'provider failure projection requires caller-owned route/default availability proof',
);
for (const token of [
  'direct_sse_console_closeout_uses_runtime_stream_observation_for_usage_and_finish',
  'io_sse_body_internal_error_aborts_instead_of_emitting_599',
]) {
  requireText(text.serverTests, files.serverTests, token);
}
requireText(
  text.serverConsole,
  files.serverConsole,
  'emit_v3_post_commit_sse_source_console_line_for_context',
);
requireText(text.server, files.server, 'io::Error::other');

const functionMap = parseYaml(files.functionMap);
const resourceMap = parseYaml(files.resourceMap);
const mainlineMap = parseYaml(files.mainlineMap);
const verificationMap = parseYaml(files.verificationMap);
const manifest = parseYaml(files.manifest);

verifyEdgeContract({
  mapDoc: mainlineMap,
  manifestDoc: manifest,
  chainId: 'v3.provider_action_gate.mainline',
  requiredEdges: requiredV3Edges,
  mapRel: files.mainlineMap,
  manifestRel: files.manifest,
  v3: true,
});
const requiredV3Nodes = [...new Set(
  requiredV3Edges.flatMap((edge) => [edge.from_node, edge.to_node]),
)];
assertExactStrings(
  asArray(manifest?.nodes).map((node) => node?.node_id),
  requiredV3Nodes,
  `${files.manifest}: nodes`,
);
for (const [nodeId, owner] of [
  ['ProviderReqCompat06ProviderCompat', 'routecodex-v3-runtime'],
  ['V3ProviderReqOutbound08WirePayload', 'routecodex-v3-runtime'],
  ['V3Error01SourceRaised', 'routecodex-v3-error'],
  ['V3Error05ExecutionDecision', 'routecodex-v3-error'],
  ['V3RequestLocalErrorHold', 'routecodex-v3-runtime'],
  ['V3ProviderHealthObservation', 'routecodex-v3-runtime'],
  ['V3Error05RecoveryWitness', 'routecodex-v3-error'],
  ['V3Error06ClientProjected', 'routecodex-v3-error'],
  ['V3ProviderActionSuccessObserved', 'routecodex-v3-runtime'],
  ['V3ProviderActionFailureObserved', 'routecodex-v3-runtime'],
  ['V3ProviderActionSuccessFinalize', 'routecodex-v3-runtime'],
  ['V3ProviderActionSuccessRecorded', 'routecodex-v3-runtime'],
  ['V3ProviderActionFailureRecorded', 'routecodex-v3-runtime'],
  ['V3ProviderRespInbound01Raw', 'routecodex-v3-runtime'],
  ['V3ProviderResponsesEventCodec', 'routecodex-v3-runtime'],
  ['V3ProviderResponsesTerminalOrFailureObserved', 'routecodex-v3-runtime'],
]) {
  const node = asArray(manifest?.nodes).find((row) => row?.node_id === nodeId);
  if (node?.owner !== owner) {
    failures.push(`${files.manifest}: ${nodeId} owner must be ${owner}`);
  }
}
assertExactStrings(
  manifest?.resources,
  ['v3.error.execution_decision', 'v3.error.provider_action_gate', 'v3.provider.health_state'],
  `${files.manifest}: resources`,
);
assertExactStrings(
  manifest?.return_path,
  [
    'V3RequestLocalErrorHold',
    'V3Error06ClientProjected',
    'V3ProviderActionSuccessRecorded',
    'V3ProviderActionFailureRecorded',
  ],
  `${files.manifest}: return_path`,
);

const feature = asArray(functionMap.features).find((row) => row?.feature_id === 'v3.provider_action_gate');
const verification = asArray(verificationMap.features).find(
  (row) => row?.feature_id === 'v3.provider_action_gate',
);
const resource = asArray(resourceMap.resources).find(
  (row) => row?.resource_id === 'v3.error.provider_action_gate',
);
const v3Chain = asArray(mainlineMap.chains).find(
  (row) => row?.chain_id === 'v3.provider_action_gate.mainline',
);
if (feature?.status !== 'active' || feature?.runtime_status !== 'source_active_live_verification_required') {
  failures.push(`${files.functionMap}: v3.provider_action_gate must be active with live verification explicit`);
}
if (
  feature?.owner_crate !== 'routecodex-v3-runtime'
  || feature?.owner_file !== files.policy
) {
  failures.push(`${files.functionMap}: v3.provider_action_gate owner must remain routecodex-v3-runtime`);
}
assertExactStrings(
  feature?.mainline_bindings,
  requiredV3Edges.map((edge) => edge.step_id),
  `${files.functionMap}: v3.provider_action_gate.mainline_bindings`,
);
assertIncludes(
  feature?.resource_bindings,
  ['v3.error.execution_decision', 'v3.error.provider_action_gate', 'v3.provider.health_state'],
  `${files.functionMap}: v3.provider_action_gate.resource_bindings`,
);
if (verification?.status !== 'source_active_live_verification_required') {
  failures.push(`${files.verificationMap}: v3.provider_action_gate status must retain pending live proof`);
}
assertExactStrings(
  verification?.mainline_bindings,
  requiredV3Edges.map((edge) => edge.step_id),
  `${files.verificationMap}: v3.provider_action_gate.mainline_bindings`,
);
assertIncludes(
  verification?.required_positive,
  [
    'Responses Relay provider-bound request compatibility and wire encoding failures enter the shared provider failure policy and typed Error05 action lane before retry or reselect.',
  ],
  `${files.verificationMap}: v3.provider_action_gate.required_positive`,
);
assertIncludes(
  verification?.contract,
  [files.manifest, files.resourceMap, files.functionMap, files.mainlineMap, files.wiki],
  `${files.verificationMap}: v3.provider_action_gate.contract`,
);
if (resource?.binding_status !== 'anchored') {
  failures.push(`${files.resourceMap}: V3 provider action gate resource must be anchored`);
}
if (
  resource?.resource_kind !== 'request_local_error_disposition'
  || resource?.owner_crate !== 'routecodex-v3-runtime'
  || resource?.owner_node !== 'V3Error05ExecutionDecision'
  || resource?.lifecycle !== 'v3.provider_action_gate.mainline'
  || v3Chain?.owner_feature_id !== 'v3.provider_action_gate'
  || manifest?.lifecycle_id !== 'v3.provider_action_gate.mainline'
  || manifest?.owner_feature !== 'v3.provider_action_gate'
) {
  failures.push(
    `${files.resourceMap} + ${files.mainlineMap} + ${files.manifest}: V3 lifecycle/chain/owner binding drift`,
  );
}
if (
  manifest?.downstream_projection?.owner_crate !== 'routecodex-v3-error'
  || manifest?.downstream_projection?.input_node !== 'V3Error05ExecutionDecision'
  || manifest?.downstream_projection?.output_node !== 'V3Error06ClientProjected'
  || manifest?.downstream_projection?.provider_action_gate_witness !== 'none'
) {
  failures.push(`${files.manifest}: downstream Error06 projection must remain routecodex-v3-error owned with no gate witness`);
}
assertIncludes(
  resource?.allowed_writers,
  [
    'run_v3_relay_provider_failure_policy_with_response_source_inner',
    'run_v3_direct_provider_failure_policy',
  ],
  `${files.resourceMap}: v3.error.provider_action_gate.allowed_writers`,
);
if (Object.hasOwn(manifest, 'admission_permit')
    || manifest?.error_return?.hold_ms !== 2000
    || manifest?.error_return?.ownership !== 'per_request'
    || manifest?.error_return?.shared_admission !== 'forbidden'
    || manifest?.error_return?.health_recording !== 'immediate_before_hold') {
  failures.push(`${files.manifest}: Error return must be request-local, without admission, and follow immediate health recording`);
}
{
  const objectFlows = manifest?.object_flows;
  if (objectFlows?.sese_scope !== 'per_flow_only_whole_lifecycle_multi_terminal') {
    failures.push(
      `${files.manifest}: object_flows must scope SESE to each actual flow; the multi-terminal action lifecycle must not be claimed as whole-lifecycle SESE`,
    );
  }
  for (const [name, entry, exit] of [
    ['error_disposition', 'source_failure', 'internal_error_outcome'],
    ['request_recovery', 'failed_request_recovery_witness', 'request_recovery_disposition'],
    ['fresh_request_attempt', 'fresh_independent_request', 'request_attempt_disposition'],
  ]) {
    const flow = objectFlows?.[name];
    if (!flow || flow.entry !== entry || flow.exit !== exit) {
      failures.push(
        `${files.manifest}: object_flows.${name} must have exactly one entry ${entry} and one exit ${exit}`,
      );
    }
  }
}
if (Object.hasOwn(manifest, 'admission_lease')) {
  failures.push(`${files.manifest}: disproved admission_lease contract must be physically removed`);
}
assertIncludes(
  resource?.required_gates,
  [
    'npm run verify:v3-provider-action-gate',
    'npm run test:v3-provider-action-gate-red-fixtures',
    'npm run verify:v3-resource-map',
  ],
  `${files.resourceMap}: v3.error.provider_action_gate.required_gates`,
);
if (manifest.status !== 'active') {
  failures.push('provider action gate V3 manifest must be active');
}
const v3WikiMermaid = extractSingleMermaidBlock(text.wiki, files.wiki);
assertExactStrings(
  extractWikiStepIds(v3WikiMermaid, 'v3-provider-action-gate-'),
  requiredV3Edges.map((edge) => edge.step_id),
  `${files.wiki}: machine edge IDs`,
);
for (const [stepId, fromAlias, toAlias] of [
  ['v3-provider-action-gate-01', 'Compat', 'E05'],
  ['v3-provider-action-gate-02', 'Wire', 'E05'],
  ['v3-provider-action-gate-03', 'E01', 'Witness'],
  ['v3-provider-action-gate-04', 'E05', 'Hold'],
  ['v3-provider-action-gate-05', 'E05', 'E06'],
  ['v3-provider-action-gate-06', 'E01', 'Health'],
  ['v3-provider-action-gate-14', 'E01', 'E05'],
  ['v3-provider-action-gate-15', 'E01', 'E05'],
  ['v3-provider-action-gate-16', 'E01', 'E05'],
  ['v3-provider-action-gate-33', 'ProviderOutcome', 'SuccessObserved'],
  ['v3-provider-action-gate-34', 'SuccessObserved', 'SuccessRecorded'],
  ['v3-provider-action-gate-35', 'ProviderOutcome', 'FailureObserved'],
  ['v3-provider-action-gate-36', 'FailureObserved', 'FailureRecorded'],
  ['v3-provider-action-gate-37', 'ProviderOutcome', 'SuccessRecorded'],
  ['v3-provider-action-gate-39', 'ProviderOutcome', 'FailureObserved'],
  ['v3-provider-action-gate-40', 'FailureObserved', 'FailureRecorded'],
  ['v3-provider-action-gate-43', 'ProviderOutcome', 'FailureObserved'],
  ['v3-provider-action-gate-44', 'FailureObserved', 'FailureRecorded'],
  ['v3-provider-action-gate-45', 'ProviderOutcome', 'SuccessRecorded'],
  ['v3-provider-action-gate-46', 'ProviderOutcome', 'SuccessFinalize'],
  ['v3-provider-action-gate-47', 'SuccessFinalize', 'SuccessRecorded'],
  ['v3-provider-action-gate-48', 'ProviderRaw', 'ProviderCodec'],
  ['v3-provider-action-gate-49', 'ProviderCodec', 'ProviderOutcome'],
  ['v3-provider-action-gate-50', 'ProviderRaw', 'ProviderCodec'],
  ['v3-provider-action-gate-51', 'ProviderCodec', 'ProviderOutcome'],
]) {
  assertWikiEdge(v3WikiMermaid, files.wiki, stepId, fromAlias, toAlias);
}
if (/\b(?:Gate|TerminalAdmission|TerminalCommit|Permit|AbandonRequest|Abandoned)\s*\[/u.test(v3WikiMermaid)) {
  failures.push(`${files.wiki}: retired provider action admission nodes must not be declared`);
}

let packageJson = {};
try {
  packageJson = JSON.parse(text.packageJson);
} catch (error) {
  failures.push(`package.json: JSON parse failed: ${error.message}`);
}
const commands = {
  'test:v3-provider-action-gate': 'CARGO_NET_OFFLINE=true node scripts/run-v3-cargo-test.mjs -p routecodex-v3-error && CARGO_NET_OFFLINE=true node scripts/run-v3-cargo-test.mjs -p routecodex-v3-server --test multi_listener_server hold_does_not_block_same_identity -- --test-threads=1 --nocapture && CARGO_NET_OFFLINE=true node scripts/run-v3-cargo-test.mjs -p routecodex-v3-server --test multi_listener_server 429_healthy_alternatives_keep_parallelism -- --test-threads=1 --nocapture && CARGO_NET_OFFLINE=true node scripts/run-v3-cargo-test.mjs -p routecodex-v3-server --test multi_listener_server issue44cc3af_mixed_pool_ -- --test-threads=1 --nocapture',
  'verify:v3-provider-action-gate': 'node scripts/architecture/verify-v3-provider-action-gate.mjs',
  'test:v3-provider-action-gate-red-fixtures': 'node scripts/tests/v3-provider-action-gate-red-fixtures.mjs',
};
for (const [name, command] of Object.entries(commands)) {
  if (packageJson.scripts?.[name] !== command) failures.push(`package.json: script ${name} must equal ${command}`);
}
for (const scriptName of ['verify:v3-architecture-docs', 'build:v3-cli']) {
if (!String(packageJson.scripts?.[scriptName] || '').includes('npm run verify:v3-provider-action-gate')) {
    failures.push(`package.json: ${scriptName} must run npm run verify:v3-provider-action-gate`);
  }
}
requireText(text.workflow, files.workflow, 'npm --prefix v3 run verify:ci');

// Error storm control must not become a provider admission lane. Keep this
// guard until the older edge manifest is migrated to the error-local policy.
for (const [rel, source] of [
  [files.direct, text.direct],
  ['v3/crates/routecodex-v3-runtime/src/kernel/v3_direct_core.rs', read('v3/crates/routecodex-v3-runtime/src/kernel/v3_direct_core.rs')],
  [files.responsesInner, text.responsesInner],
  [files.relayCore, text.relayCore],
  [files.anthropic, text.anthropic],
]) {
  if (/\bwait_for_error05_recovery\s*\(|\b(?:_?provider_action_permit|V3ProviderActionAdmission|V3ProviderActionPermit|waiter_queue)\b/u.test(maskCommentsAndStrings(source))) {
    failures.push(`${rel}: request execution must not wait on a provider action permit`);
  }
}
const serverEntry = findFunctionBody(text.server, 'pending_model_request', files.server);
if (/\b(?:request_activity_gate|request_activity_permit|hold_response_body_request_activity_permit)\b/u.test(serverEntry)) {
  failures.push(`${files.server}: request entry must not acquire or retain a shared activity permit`);
}
const directExecution = findFunctionBody(text.direct, 'execute_v3_responses_direct_runtime_kernel_core_resident', files.direct);
if (/\bv3_direct_selected_available_for_send\s*\(/u.test(directExecution)) {
  failures.push(`${files.direct}: selected provider must not pass a second send admission gate`);
}
const errorHoldBody = findFunctionBody(text.policy, 'hold_provider_error_return', files.policy);
if (!/tokio::time::sleep\s*\(\s*std::time::Duration::from_secs\(2\)\s*\)\s*\.await/u.test(errorHoldBody)) {
  failures.push(`${files.policy}: each applicable error return must hold independently for two seconds`);
}
for (const [rel, source] of [[files.policy, text.policy], [files.directHelpers, text.directHelpers]]) {
  if (!source.includes('hold_provider_error_return().await')) {
    failures.push(`${rel}: provider error policy must apply the independent return hold`);
  }
}
for (const [rel, source, name] of [
  [files.policy, text.policy, 'run_v3_relay_provider_failure_policy_with_response_source'],
  [files.directHelpers, text.directHelpers, 'run_v3_direct_provider_failure_policy'],
]) {
  const body = findFunctionBody(source, name, rel);
  if (!/result\s*\.\s*as_ref\(\)\s*\.\s*is_ok_and\s*\(\s*\|outcome\|\s*\{\s*matches!\(\s*outcome\.decision\.action,\s*(?:routecodex_v3_error::)?V3Error05ExecutionAction::ProjectTerminal\s*\)/u.test(body)) {
    failures.push(`${rel}: final error hold must not delay provider recovery actions`);
  }
}

if (failures.length) {
  console.error('[verify:v3-provider-action-gate] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-provider-action-gate] ok');
console.log(`- V3 required machine edges: ${requiredV3Edges.length}`);
console.log('- every declared symbol exists and every caller body invokes its declared callee');
console.log('- V3 map-manifest endpoints, status, symbols, files, and owner bindings are synchronized');
