#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { attachProviderActionGateHelpers } from './v3-provider-action-gate-lib.mjs';

const root = process.cwd();
const failures = [];
const files = {
  gate: 'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs',
  policy: 'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs',
  policyTests: 'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy/tests.rs',
  error: 'v3/crates/routecodex-v3-error/src/lib.rs',
  direct: 'v3/crates/routecodex-v3-runtime/src/kernel.rs',
  directHelpers: 'v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers.rs',
  directUnitTests: 'v3/crates/routecodex-v3-runtime/src/kernel/tests.rs',
  directExactPinTests: 'v3/crates/routecodex-v3-runtime/src/kernel/tests/exact_pin.rs',
  directSse: 'v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs',
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
  gateTests: 'v3/crates/routecodex-v3-runtime/tests/provider_action_gate_contract.rs',
  openaiChatTests: 'v3/crates/routecodex-v3-runtime/tests/openai_chat_relay_runtime_integration.rs',
  geminiTests: 'v3/crates/routecodex-v3-runtime/tests/gemini_relay_runtime_integration.rs',
  directSseTests: 'v3/crates/routecodex-v3-runtime/tests/responses_direct_remote_continuation_integration.rs',
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
  packageJson: 'package.json',
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
  'execute_v3_responses_relay_runtime_inner',
  files.responses,
);
for (const [label, pattern] of [
  [
    'ProviderReqCompat06ProviderCompat request-local fail-fast branch',
    /let\s+req_compat\s*=\s*match\s+build_provider_req_compat_06_from_v3_hub_req_outbound_07\s*\(req07\)\s*\{[\s\S]{0,900}?Err\s*\(error\)\s*=>\s*\{[\s\S]{0,500}?handle_provider_request_failure!\s*\(\s*V3ResponsesRelayRuntimeError::ProviderCompat\s*\(\s*error\s*\)\s*\)\s*;/u,
  ],
  [
    'V3ProviderReqOutbound08WirePayload failure branch',
    /let\s+wire\s*=\s*match\s+build_v3_provider_12_responses_wire_payload\s*\([\s\S]{0,1200}?\)\s*\{[\s\S]{0,1200}?Err\s*\(\s*error\s*\)\s*=>\s*\{\s*handle_provider_request_failure!\s*\(\s*V3ResponsesRelayRuntimeError::Provider\s*\(\s*error\s*\)\s*\)\s*;/u,
  ],
]) {
  if (!pattern.test(responsesRelayRequestBody)) {
    failures.push(
      label.startsWith('V3ProviderReqOutbound08WirePayload')
        ? `${files.responses}: ${label} must enter handle_provider_request_failure`
        : `${files.responses}: ${label} is missing`,
    );
  }
}
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
  callee_symbol: 'run_v3_relay_provider_failure_policy',
  callee_file: files.policy,
});
const responsesRelayFailureHandlerBody = findFunctionBody(
  text.responses,
  'handle_v3_responses_relay_provider_failure',
  files.responses,
);
if (
  !/^\{\s*if\s+failure\.terminal_projection\.is_some\(\)\s*\{\s*return\s+Ok\(Some\(failure\)\);\s*\}\s*let\s+result\s*=\s*run_v3_relay_provider_failure_policy\s*\(/u
    .test(responsesRelayFailureHandlerBody)
) {
  failures.push(
    `${files.responses}: handle_v3_responses_relay_provider_failure must enter run_v3_relay_provider_failure_policy immediately after its existing terminal projection guard`,
  );
}

for (const token of [
  'pub const V3_PROVIDER_ACTION_ISOLATED_DELAY_MS: u64 = 1_000;',
  'pub const V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS: u64 = 5_000;',
  'pub fn process_shared() -> Self',
  'static SHARED: OnceLock<V3ProviderActionGate>',
  'pub(crate) struct V3ProviderActionPermit',
  'impl Drop for V3ProviderActionPermit',
  'self.gate.abandon_admission(&self.key, self.generation)',
  'waiter_queue: VecDeque<u64>',
  'state.waiter_queue.len() > 1',
  'state.admitted_generation == Some(state.generation)',
  'let active_admission_owned = states.iter().any',
  'if !active_admission_owned {',
  'let group_has_active_admission = states.iter().any',
  '(!self.admit_action || !group_has_active_admission)',
  'record_failure_and_wait_for_terminal_projection',
  'pub async fn wait_for_exact_provider_action(',
  'pub fn abandon_admission(',
  'pub fn commit_terminal_admission(',
  'V3ProviderActionRecoveryTransition',
  'state.next_admission_at =\n                            now + Duration::from_millis(V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS);',
]) {
  requireText(text.gate, files.gate, token);
}
requireText(text.gate, files.gate, 'active_lane_generation');
const recordProviderSuccessBody = findFunctionBody(
  text.gate,
  'V3ProviderActionGate::record_provider_success',
  files.gate,
);
if (
  !/key\.provider_scope\s*==\s*\*provider_scope\s*\|\|\s*state\.admitted_action_scope\.as_ref\(\)\s*==\s*Some\(provider_scope\)/u
    .test(recordProviderSuccessBody)
) {
  failures.push(
    `${files.gate}: provider success may release only its exact provider scope or the permit-owned action scope`,
  );
}
for (const forbidden of [
  'provider action gate state disappeared without an explicit transition',
  'provider action gate notification channel closed without an explicit transition',
]) {
  requireText(text.gate, files.gate, forbidden);
}
if (
  /generation:\s*0,[\s\S]{0,180}?released_by_success:\s*true/u.test(text.gate)
) {
  failures.push(
    `${files.gate}: missing state or notification closure must not be wrapped as provider success`,
  );
}
if (
  text.gate.includes(
    'state.admitted_generation == Some(state.generation)\n                    && now >= state.next_admission_at',
  )
) {
  failures.push(
    `${files.gate}: admitted provider action must not expire from wall-clock time while its permit is owned`,
  );
}
if (
  !/ReleasedBySuccess\s*\(\s*V3ProviderActionRecoveryTicket\s*\)/u.test(text.gate)
) {
  failures.push(
    `${files.gate}: success-released recovery transition must carry the exact retained recovery ticket`,
  );
}

for (const token of [
  'pub struct V3Error05RecoveryAdmissionWitness',
  'pub enum V3Error05ExecutionAction',
  'WaitThenRetrySame',
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
  requireText(source, rel, 'wait_for_error05_recovery');
  requireText(source, rel, 'V3ProviderActionGateAdmission');
  requireText(source, rel, 'V3ProviderActionRecoveryTransition::Superseded');
  requireText(source, rel, 'V3ProviderActionRecoveryTransition::ReleasedBySuccess');
  requireText(source, rel, 'V3ProviderActionGateTerminalReevaluation');
  const successReleaseRearm =
    /V3ProviderActionRecoveryTransition::ReleasedBySuccess\(ticket\)[\s\S]{0,80}?=>\s*\{[\s\S]{0,480}?pending_provider_action_recovery\s*=[\s\S]{0,220}?ticket[\s\S]{0,120}?recovery_witness\(\)/u;
  if (!successReleaseRearm.test(source)) {
    failures.push(
      `${rel}: ${name} must re-arm the exact retained recovery ticket after provider success releases a queued waiter`,
    );
  }
  if (!source.includes('V3Error05ExecutionAction')) {
    failures.push(`${rel}: ${name} must consume typed Error05 actions`);
  }
  requireText(source, rel, 'let mut pending_provider_action_recovery = None;');
  const recoveryOnlyWait = /if\s+let\s+Some\(recovery\)\s*=\s*pending_provider_action_recovery\.take\(\)\s*\{[\s\S]{0,700}?wait_for_error05_recovery/u;
  if (!recoveryOnlyWait.test(source)) {
    failures.push(
      `${rel}: ${name} must wait on the provider action gate only after the current request enters Error05 recovery`,
    );
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
  requireText(source, rel, 'wait_for_error05_recovery');
  requireText(source, rel, 'V3ProviderActionGateAdmission');
  requireText(source, rel, 'V3ProviderActionRecoveryTransition::Superseded');
  requireText(source, rel, 'V3ProviderActionRecoveryTransition::ReleasedBySuccess');
  requireText(source, rel, 'V3ProviderActionGateTerminalReevaluation');
  const successReleaseRearm =
    /V3ProviderActionRecoveryTransition::ReleasedBySuccess\(ticket\)[\s\S]{0,80}?=>\s*\{[\s\S]{0,480}?pending_provider_action_recovery\s*=[\s\S]{0,220}?ticket[\s\S]{0,120}?recovery_witness\(\)/u;
  if (!successReleaseRearm.test(source)) {
    failures.push(
      `${rel}: ${name} must re-arm the exact retained recovery ticket after provider success releases a queued waiter`,
    );
  }
  if (!source.includes('V3Error05ExecutionAction')) {
    failures.push(`${rel}: ${name} must consume typed Error05 actions`);
  }
  requireText(source, rel, 'let mut pending_provider_action_recovery = None;');
  const recoveryOnlyWait = /if\s+let\s+Some\(recovery\)\s*=\s*pending_provider_action_recovery\.take\(\)\s*\{[\s\S]{0,700}?wait_for_error05_recovery/u;
  if (!recoveryOnlyWait.test(source)) {
    failures.push(
      `${rel}: ${name} must wait on the provider action gate only after the current request enters Error05 recovery`,
    );
  }
  if (source.includes('pending_provider_action_gate')) {
    failures.push(`${rel}: ${name} must not retain bool-only provider action recovery state`);
  }
  if (source.includes('wait_for_selected_provider_action')) {
    failures.push(`${rel}: ${name} must not select a recovery lane by latest routing-group state`);
  }
}
requireText(text.direct, files.direct, 'let mut continuation_provider_action_lookup = previous_response_id.is_some();');
requireText(text.direct, files.direct, 'wait_for_exact_selected_provider_action');
requireText(text.directSse, files.directSse, 'classify_v3_provider_responses_json_data(&data)');
if (/event_type|event\s*==\s*["']response\./u.test(text.directSse)) {
  failures.push(
    `${files.directSse}: SSE event metadata must not be used as provider semantic source`,
  );
}
if (text.directHelpers.includes('wrap_direct_sse_stopless_control_stream')) {
  failures.push(`${files.directHelpers}: removed SSE stopless stream wrapper must not reappear`);
}
requireText(text.policy, files.policy, 'V3RelayProviderTargetResolution::Exhausted');
if (text.policy.includes('if let Ok(alternative) = resolve_v3_relay_target')) {
  failures.push(
    `${files.policy}: target-resolution source errors must not be swallowed as provider-pool exhaustion`,
  );
}
for (const token of [
  'V3ProviderActionRecoveryTicket',
  'V3ProviderActionRecoveryTransition',
  'wait_for_recovery_ticket',
  'recovery_ticket',
]) {
  requireText(text.gate, files.gate, token);
}
requireText(
  text.responses,
  files.responses,
  'Some("response.completed") => Some("completed".to_string()),',
);
requireText(
  text.responsesCodec,
  files.responsesCodec,
  'Some("response.completed") => {',
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
requireOccurrenceCount(text.direct, files.direct, 'drop(provider_action_permit.take());', 3);
requireOccurrenceCount(
  text.directSse,
  files.directSse,
  'drop(self._provider_action_permit.take());',
  1,
);
requireOccurrenceCount(
  text.responses,
  files.responses,
  'drop(_provider_action_permit.take());',
  9,
);
// openai_chat/gemini 的局部变量 permit drop（每协议 4 处）已收敛到统一 relay 骨架。
requireOccurrenceCount(
  text.relayCore,
  files.relayCore,
  'drop(provider_action_permit.take());',
  4,
);
requireOccurrenceCount(
  text.openaiChat,
  files.openaiChat,
  'drop(self._provider_action_permit.take());',
  1,
);
requireOccurrenceCount(
  text.anthropic,
  files.anthropic,
  'drop(_provider_action_permit.take());',
  7,
);
requireOccurrenceCount(
  text.gemini,
  files.gemini,
  'drop(self._provider_action_permit.take());',
  1,
);
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
  'action_gate: V3ProviderActionGate::process_shared()',
  'project_v3_client_disconnect',
  'record_provider_action_failure',
  'wait_for_terminal_provider_projection',
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

const requiredGateTests = [
  'isolated_failure_blocks_one_action_for_at_least_one_second',
  'isolated_terminal_projection_waits_for_the_same_one_second_gate',
  'unrelated_success_cannot_release_a_stale_terminal_projection',
  'overlapping_waiter_promotes_scope_to_five_seconds_and_one_admission',
  'process_shared_handles_observe_the_same_cross_request_generation',
  'terminal_transition_wakes_old_waiter_for_reselection_then_serializes_next_generation',
  'changing_provider_and_error_family_cannot_restart_an_active_lane_at_one_second',
  'admitted_action_requires_explicit_drop_before_replacement_generation',
  'unrelated_same_group_provider_success_cannot_release_an_owned_action_permit',
  'fifo_waiter_cancellation_removes_only_its_ticket',
  'success_released_recovery_reenters_the_retained_five_second_generation',
];
for (const testName of requiredGateTests) {
  assertRustTest(text.gateTests, files.gateTests, testName);
}
for (const token of [
  'post_commit_sse_failure_records_failure_but_does_not_block_a_fresh_request',
  'terminal_sse_recovery_does_not_block_a_fresh_request',
  'active_recovery_sse_blocks_a_second_recovery_beyond_five_seconds',
]) {
  assertRustTest(text.openaiChatTests, files.openaiChatTests, token);
  assertRustTest(text.geminiTests, files.geminiTests, token);
}
assertRustTest(
  text.openaiChatTests,
  files.openaiChatTests,
  'provider_error_enters_error01_06_without_success_projection',
);
assertRustTest(
  text.geminiTests,
  files.geminiTests,
  'provider_error_enters_error01_06_without_success_projection',
);
assertRustTest(
  text.responsesRelayTests,
  files.responsesRelayTests,
  'responses_relay_terminal_missing_fails_explicitly_but_fresh_request_bypasses_recovery',
);
for (const token of [
  'provider_sse_done_without_completed_is_terminal_missing',
  'provider_sse_requires_action_without_completed_is_terminal_missing',
]) {
  assertRustTest(text.responsesRelayUnitTests, files.responsesRelayUnitTests, token);
}
for (const token of [
  'direct_post_commit_malformed_sse_records_failure_but_fresh_request_bypasses_recovery',
  'direct_post_commit_response_failed_records_failure_but_fresh_request_bypasses_recovery',
  'direct_terminal_sse_recovery_does_not_block_a_fresh_request',
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
requireText(
  text.directHelpers,
  files.directHelpers,
  'if matches!(source.source_kind, V3ErrorSourceKind::ClientDisconnect)',
);
for (const token of [
  'V3ExactPinAvailabilityExhaustion',
  'continuation_exact_pin_unavailable',
]) {
  requireText(text.directHelpers, files.directHelpers, token);
}
requireText(
  text.directExactPinTests,
  files.directExactPinTests,
  'missing_exact_pin_is_provider_availability_error05_without_router_reentry',
);
for (const token of [
  'provider_failure_with_route_capacity_is_typed_nonterminal_error05',
  'provider_failure_with_same_provider_budget_is_typed_retry_same',
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
  'direct_sse_console_closeout_abruptly_closes_without_fabricating_error06',
  'relay_sse_body_abruptly_closes_without_fabricating_error_event',
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
  ['V3Error05RecoveryWitness', 'routecodex-v3-error'],
  ['V3ProviderActionGateAdmission', 'routecodex-v3-runtime'],
  ['V3ExecutionRetryOrReselect', 'routecodex-v3-runtime'],
  ['V3ProviderActionGateTerminalAdmission', 'routecodex-v3-runtime'],
  ['V3ProviderActionGateTerminalCommitted', 'routecodex-v3-runtime'],
  ['V3ProviderActionPermitInFlight', 'routecodex-v3-runtime'],
  ['V3ProviderActionPermitAbandonRequested', 'routecodex-v3-runtime'],
  ['V3ProviderActionPermitAbandoned', 'routecodex-v3-runtime'],
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
    'V3ExecutionRetryOrReselect',
    'V3ProviderActionGateTerminalCommitted',
    'V3ProviderActionSuccessRecorded',
    'V3ProviderActionFailureRecorded',
    'V3ProviderActionPermitAbandoned',
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
  || feature?.owner_file !== files.gate
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
  resource?.resource_kind !== 'process_local_control_side_channel'
  || resource?.owner_crate !== 'routecodex-v3-runtime'
  || resource?.owner_node !== 'V3ProviderActionGateAdmission'
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
    'V3ProviderActionGate::abandon_admission',
    'V3ProviderActionGate::commit_terminal_admission',
  ],
  `${files.resourceMap}: v3.error.provider_action_gate.allowed_writers`,
);
if (
  manifest?.admission_permit?.owner_type !== 'V3ProviderActionPermit'
  || manifest?.admission_permit?.wall_clock_expiry !== 'forbidden'
  || manifest?.admission_permit?.fresh_request_consumes_active_recovery_lane !== false
  || manifest?.admission_permit?.waiter_order !== 'fifo_ticket'
) {
  failures.push(
    `${files.manifest}: admission_permit must lock explicit ownership, no wall-clock expiry, FIFO, and fresh-request isolation`,
  );
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
  ['v3-provider-action-gate-03', 'E05', 'Witness'],
  ['v3-provider-action-gate-04', 'Witness', 'Gate'],
  ['v3-provider-action-gate-05', 'E05', 'TerminalAdmission'],
  ['v3-provider-action-gate-06', 'TerminalAdmission', 'TerminalCommit'],
  ['v3-provider-action-gate-07', 'Gate', 'Retry'],
  ['v3-provider-action-gate-08', 'Witness', 'Gate'],
  ['v3-provider-action-gate-09', 'Retry', 'Gate'],
  ['v3-provider-action-gate-10', 'Witness', 'Gate'],
  ['v3-provider-action-gate-11', 'Witness', 'Gate'],
  ['v3-provider-action-gate-12', 'Witness', 'Gate'],
  ['v3-provider-action-gate-13', 'Witness', 'Gate'],
  ['v3-provider-action-gate-14', 'E01', 'E05'],
  ['v3-provider-action-gate-15', 'E01', 'E05'],
  ['v3-provider-action-gate-16', 'E01', 'E05'],
  ['v3-provider-action-gate-19', 'Gate', 'Permit'],
  ['v3-provider-action-gate-20', 'Gate', 'Permit'],
  ['v3-provider-action-gate-21', 'Gate', 'Permit'],
  ['v3-provider-action-gate-22', 'Gate', 'Permit'],
  ['v3-provider-action-gate-23', 'Gate', 'Permit'],
  ['v3-provider-action-gate-24', 'Permit', 'AbandonRequest'],
  ['v3-provider-action-gate-25', 'Permit', 'AbandonRequest'],
  ['v3-provider-action-gate-26', 'Permit', 'AbandonRequest'],
  ['v3-provider-action-gate-27', 'Permit', 'AbandonRequest'],
  ['v3-provider-action-gate-28', 'Permit', 'AbandonRequest'],
  ['v3-provider-action-gate-29', 'Permit', 'AbandonRequest'],
  ['v3-provider-action-gate-30', 'Permit', 'AbandonRequest'],
  ['v3-provider-action-gate-31', 'Permit', 'AbandonRequest'],
  ['v3-provider-action-gate-32', 'AbandonRequest', 'Abandoned'],
  ['v3-provider-action-gate-33', 'Permit', 'SuccessObserved'],
  ['v3-provider-action-gate-34', 'SuccessObserved', 'SuccessRecorded'],
  ['v3-provider-action-gate-35', 'Permit', 'FailureObserved'],
  ['v3-provider-action-gate-36', 'Abandoned', 'FailureRecorded'],
  ['v3-provider-action-gate-37', 'Permit', 'SuccessObserved'],
  ['v3-provider-action-gate-38', 'SuccessObserved', 'SuccessRecorded'],
  ['v3-provider-action-gate-39', 'Permit', 'FailureObserved'],
  ['v3-provider-action-gate-40', 'Abandoned', 'FailureRecorded'],
  ['v3-provider-action-gate-41', 'Permit', 'SuccessObserved'],
  ['v3-provider-action-gate-42', 'SuccessObserved', 'SuccessRecorded'],
  ['v3-provider-action-gate-43', 'Permit', 'FailureObserved'],
  ['v3-provider-action-gate-44', 'Abandoned', 'FailureRecorded'],
  ['v3-provider-action-gate-45', 'Permit', 'SuccessRecorded'],
  ['v3-provider-action-gate-46', 'Permit', 'SuccessFinalize'],
  ['v3-provider-action-gate-47', 'SuccessFinalize', 'SuccessRecorded'],
  ['v3-provider-action-gate-48', 'ProviderRaw', 'ProviderCodec'],
  ['v3-provider-action-gate-49', 'ProviderCodec', 'ProviderOutcome'],
  ['v3-provider-action-gate-50', 'ProviderRaw', 'ProviderCodec'],
  ['v3-provider-action-gate-51', 'ProviderCodec', 'ProviderOutcome'],
]) {
  assertWikiEdge(v3WikiMermaid, files.wiki, stepId, fromAlias, toAlias);
}
if (/^\s*TerminalCommit\s*-->/mu.test(v3WikiMermaid)) {
  failures.push(`${files.wiki}: terminal commit cannot claim a downstream machine edge`);
}

let packageJson = {};
try {
  packageJson = JSON.parse(text.packageJson);
} catch (error) {
  failures.push(`package.json: JSON parse failed: ${error.message}`);
}
const commands = {
  'test:v3-provider-action-gate': 'CARGO_NET_OFFLINE=true node scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-error && CARGO_NET_OFFLINE=true node scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --test provider_action_gate_contract -- --test-threads=1 --nocapture',
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
for (const command of Object.keys(commands).map((name) => `npm run ${name}`)) {
  requireText(text.workflow, files.workflow, command);
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
