#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const failures = [];
const paths = {
  resourceMap: 'docs/architecture/v3-resource-operation-map.yml',
  functionMap: 'docs/architecture/v3-function-map.yml',
  mainlineMap: 'docs/architecture/v3-mainline-call-map.yml',
  verificationMap: 'docs/architecture/v3-verification-map.yml',
  manifest: 'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
  snapshotContract: 'docs/architecture/snapshot-stage-contract.md',
  hub: 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
  hubCommon: 'v3/crates/routecodex-v3-runtime/src/hub_v1/common.rs',
  runtime: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
  hooks: 'v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs',
  packageJson: 'package.json',
};

const resourceId = 'v3.metadata.runtime_control_stopless';
const featureId = 'v3.servertool_hook_skeleton_lifecycle';
const verifyGate = 'npm run verify:v3-stopless-resource-control';
const redGate = 'npm run test:v3-stopless-resource-control-red-fixtures';
const cliGate = 'npm run jest:run -- --runTestsByPath tests/cli/servertool-command.spec.ts';

const resourceMap = readYaml(paths.resourceMap);
const functionMap = readYaml(paths.functionMap);
const mainlineMap = readYaml(paths.mainlineMap);
const verificationMap = readYaml(paths.verificationMap);
const manifest = readYaml(paths.manifest);
const snapshotContract = readText(paths.snapshotContract);
const hubSource = [readText(paths.hub), readText(paths.hubCommon)].join('\n');
const runtimeSource = readText(paths.runtime);
const hookSource = readText(paths.hooks);
const packageJson = readJson(paths.packageJson);

verifyPackageScripts();
verifyResourceOwner();
verifyLifecycleManifest();
verifyFunctionAndVerificationMaps();
verifyMainlineOwnership();
verifyRuntimeSeparation();
verifyStoplessStateMachineShape();
verifyCliProjection();
verifyStoplessGuideline();
verifySnapshotBoundary();

if (failures.length > 0) {
  console.error('[verify:v3-stopless-resource-control] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:v3-stopless-resource-control] ok');
console.log('- StoplessCenter semantic owner: Metadata Center / StoplessCenterMetadataControl');
console.log('- CLI projection: no-input no-op, no scope/state/envelope');
console.log('- resource access: declared Stopless SOP edges only');

function abs(rel) {
  return path.resolve(root, rel);
}

function fail(message) {
  failures.push(message);
}

function readText(rel) {
  try {
    return fs.readFileSync(abs(rel), 'utf8');
  } catch (error) {
    fail(`${rel}: cannot read: ${error.message}`);
    return '';
  }
}

function readYaml(rel) {
  const source = readText(rel);
  try {
    return YAML.parse(source) ?? {};
  } catch (error) {
    fail(`${rel}: invalid YAML: ${error.message}`);
    return {};
  }
}

function readJson(rel) {
  const source = readText(rel);
  try {
    return JSON.parse(source);
  } catch (error) {
    fail(`${rel}: invalid JSON: ${error.message}`);
    return {};
  }
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label} must equal ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function requireArrayIncludes(values, required, label) {
  if (!Array.isArray(values) || !values.includes(required)) {
    fail(`${label} must include ${required}`);
  }
}

function requireTextIncludes(source, token, label) {
  if (!source.includes(token)) fail(`${label} missing ${token}`);
}

function verifyPackageScripts() {
  const scripts = packageJson.scripts ?? {};
  requireEqual(
    scripts['verify:v3-stopless-resource-control'],
    'node scripts/architecture/verify-v3-stopless-resource-control.mjs',
    'package script verify:v3-stopless-resource-control',
  );
  requireEqual(
    scripts['test:v3-stopless-resource-control-red-fixtures'],
    'node scripts/tests/v3-stopless-resource-control-red-fixtures.mjs',
    'package script test:v3-stopless-resource-control-red-fixtures',
  );
  requireTextIncludes(
    scripts['verify:v3-architecture-docs'] ?? '',
    'verify:v3-stopless-resource-control',
    'package script verify:v3-architecture-docs',
  );
}

function verifyResourceOwner() {
  const resources = Array.isArray(resourceMap.resources) ? resourceMap.resources : [];
  const resource = resources.find((candidate) => candidate?.resource_id === resourceId);
  if (!resource) {
    fail(`${paths.resourceMap}: missing ${resourceId}`);
    return;
  }
  requireEqual(resource.resource_kind, 'metadata_center_control_signal', `${resourceId}.resource_kind`);
  requireEqual(resource.lifecycle, 'v3.metadata.center.mainline', `${resourceId}.lifecycle`);
  requireEqual(resource.owner_feature_id, featureId, `${resourceId}.owner_feature_id`);
  requireEqual(resource.owner_node, 'StoplessCenterMetadataControl', `${resourceId}.owner_node`);
  requireEqual(resource.signal_kind, 'control_signal', `${resourceId}.signal_kind`);
  requireEqual(resource.state_machine_required, true, `${resourceId}.state_machine_required`);
  for (const field of [
    'phase',
    'consecutive_stop_count',
    'max_stop_budget',
    'last_stop_kind',
    'need_continue',
    'blocked',
    'terminal',
    'guard_exhausted',
    'next_request_policy',
    'last_request_id',
    'last_response_id',
    'last_transition_reason',
    'updated_at',
  ]) {
    requireArrayIncludes(resource.state_fields, field, `${resourceId}.state_fields`);
  }
  requireEqual(resource.data_control_separation, 'required', `${resourceId}.data_control_separation`);
  requireEqual(resource.normal_payload_state, 'forbidden', `${resourceId}.normal_payload_state`);
  requireEqual(resource.may_enter_provider_body, false, `${resourceId}.may_enter_provider_body`);
  requireEqual(resource.may_enter_client_body, false, `${resourceId}.may_enter_client_body`);

  const handles = Array.isArray(resource.implementation_handles) ? resource.implementation_handles : [];
  if (!handles.some((handle) => String(handle).startsWith('V3ResponsesRelayStoplessControlState'))) {
    fail(`${resourceId}.implementation_handles must classify V3ResponsesRelayStoplessControlState as an adapter handle`);
  }
  requireEqual(resource.cli_contract?.carries_scope, false, `${resourceId}.cli_contract.carries_scope`);
  requireEqual(resource.cli_contract?.carries_state, false, `${resourceId}.cli_contract.carries_state`);
  requireEqual(resource.cli_contract?.parameters, 'none', `${resourceId}.cli_contract.parameters`);
  requireEqual(
    resource.cli_contract?.transport_envelope,
    'no_input',
    `${resourceId}.cli_contract.transport_envelope`,
  );
  requireEqual(
    resource.cli_contract?.role,
    'protocol_tool_call_completion_only',
    `${resourceId}.cli_contract.role`,
  );
  requireEqual(
    resource.process_contract?.allowed_callers,
    'current_business_sop_declared_nodes_only',
    `${resourceId}.process_contract.allowed_callers`,
  );
  requireEqual(
    resource.process_contract?.cross_process_shortcut,
    'forbidden',
    `${resourceId}.process_contract.cross_process_shortcut`,
  );
  for (const forbidden of [
    'V3LocalContinuationStore',
    'reasoningStop_cli_args',
    'reasoningStop_cli_stdout',
    'reasoningStop_empty_input_json_envelope',
    'client_payload',
    'provider_payload',
    'debug_snapshot',
    '__runtime_json',
  ]) {
    requireArrayIncludes(resource.forbidden_writers, forbidden, `${resourceId}.forbidden_writers`);
  }
  for (const forbidden of [
    'reasoningStop_cli_stdout_parser',
    'reasoningStop_cli_args_parser',
    'V3LocalContinuationStore',
    'routecodex-v3-debug_snapshot_restore',
  ]) {
    requireArrayIncludes(resource.forbidden_readers, forbidden, `${resourceId}.forbidden_readers`);
  }
}

function verifyLifecycleManifest() {
  requireEqual(manifest.lifecycle_id, featureId, `${paths.manifest}.lifecycle_id`);
  const owner = manifest.control_owner ?? {};
  requireEqual(owner.resource_id, resourceId, `${paths.manifest}.control_owner.resource_id`);
  requireEqual(owner.belongs_to, 'Metadata Center', `${paths.manifest}.control_owner.belongs_to`);
  requireEqual(owner.feature_owner, 'Stopless feature', `${paths.manifest}.control_owner.feature_owner`);
  requireEqual(
    owner.semantic_owner_node,
    'StoplessCenterMetadataControl',
    `${paths.manifest}.control_owner.semantic_owner_node`,
  );
  requireEqual(owner.signal_kind, 'control_signal', `${paths.manifest}.control_owner.signal_kind`);
  requireEqual(owner.state_machine_required, true, `${paths.manifest}.control_owner.state_machine_required`);
  for (const field of [
    'phase',
    'consecutive_stop_count',
    'max_stop_budget',
    'last_stop_kind',
    'need_continue',
    'blocked',
    'terminal',
    'guard_exhausted',
    'next_request_policy',
    'last_request_id',
    'last_response_id',
    'last_transition_reason',
    'updated_at',
  ]) {
    requireArrayIncludes(owner.state_fields, field, `${paths.manifest}.control_owner.state_fields`);
  }
  requireEqual(owner.data_control_separation, 'required', `${paths.manifest}.control_owner.data_control_separation`);
  requireEqual(owner.normal_payload_state, 'forbidden', `${paths.manifest}.control_owner.normal_payload_state`);
  requireEqual(owner.cli_contract?.carries_scope, false, `${paths.manifest}.control_owner.cli_contract.carries_scope`);
  requireEqual(owner.cli_contract?.carries_state, false, `${paths.manifest}.control_owner.cli_contract.carries_state`);
  requireEqual(owner.cli_contract?.parameters, 'none', `${paths.manifest}.control_owner.cli_contract.parameters`);
  requireEqual(
    owner.cli_contract?.transport_envelope,
    'no_input',
    `${paths.manifest}.control_owner.cli_contract.transport_envelope`,
  );
  requireEqual(
    owner.process_contract?.cross_process_shortcut,
    'forbidden',
    `${paths.manifest}.control_owner.process_contract.cross_process_shortcut`,
  );
  for (const truthSource of [
    'CLI args or stdout',
    'empty CLI JSON envelope',
    'client/provider normal payload',
    'local continuation context/store',
    'debug snapshot metadata or __runtime.json',
  ]) {
    requireArrayIncludes(owner.forbidden_truth_sources, truthSource, `${paths.manifest}.control_owner.forbidden_truth_sources`);
  }
  requireArrayIncludes(manifest.verification_gates, verifyGate, `${paths.manifest}.verification_gates`);
  requireArrayIncludes(manifest.verification_gates, redGate, `${paths.manifest}.verification_gates`);
  requireEqual(
    manifest.guidance_rewrite?.prompt_kind,
    'complete_non_persistent_current_turn_guideline',
    `${paths.manifest}.guidance_rewrite.prompt_kind`,
  );
  requireEqual(
    manifest.guidance_rewrite?.terse_continue_prompt,
    'forbidden',
    `${paths.manifest}.guidance_rewrite.terse_continue_prompt`,
  );
  requireEqual(
    manifest.guidance_rewrite?.model_visible_bridge_transparency,
    'required',
    `${paths.manifest}.guidance_rewrite.model_visible_bridge_transparency`,
  );
  if (Array.isArray(manifest.guidance_rewrite?.must_explain)) {
    fail(`${paths.manifest}.guidance_rewrite.must_explain must not revive no-op lifecycle explanations`);
  }
  for (const token of [
    'continue from restored context',
    'review current objective, existing conclusions, unfinished work, and current stop point',
    'use available tools when progress needs facts or actions',
    'call reasoningStop for complete or blocked only with evidence',
    'keep working when neither complete nor blocked',
  ]) {
    requireArrayIncludes(manifest.guidance_rewrite?.must_include, token, `${paths.manifest}.guidance_rewrite.must_include`);
  }
  for (const token of [
    'no-op',
    'CLI',
    'client tool round',
    'routecodex hook run reasoningStop',
    'finish_reason=stop',
    'consecutive stop count',
    'stop budget',
    'guard exhausted',
  ]) {
    requireArrayIncludes(
      manifest.guidance_rewrite?.forbidden_model_visible,
      token,
      `${paths.manifest}.guidance_rewrite.forbidden_model_visible`,
    );
  }
}

function verifyFunctionAndVerificationMaps() {
  const functionFeature = (functionMap.features ?? []).find((candidate) => candidate?.feature_id === featureId);
  const verificationFeature = (verificationMap.features ?? []).find((candidate) => candidate?.feature_id === featureId);
  if (!functionFeature) fail(`${paths.functionMap}: missing feature ${featureId}`);
  if (!verificationFeature) fail(`${paths.verificationMap}: missing feature ${featureId}`);
  for (const [label, feature] of [
    [paths.functionMap, functionFeature],
    [paths.verificationMap, verificationFeature],
  ]) {
    if (!feature) continue;
    const serialized = YAML.stringify(feature);
    const serializedLower = serialized.toLowerCase().replace(/\s+/gu, ' ');
    for (const token of [
      'Metadata Center control-signal',
      'state machine',
      'data/control',
      'normal payload',
      'CLI',
      'continuation',
      'debug/snapshot',
      'declared',
      'SOP',
    ]) {
      if (!serializedLower.includes(token.toLowerCase().replace(/\s+/gu, ' '))) {
        fail(`${label} ${featureId} missing ${token}`);
      }
    }
    requireArrayIncludes(feature.required_gates, verifyGate, `${label} ${featureId}.required_gates`);
    requireArrayIncludes(feature.required_gates, redGate, `${label} ${featureId}.required_gates`);
    requireArrayIncludes(feature.required_gates, cliGate, `${label} ${featureId}.required_gates`);
  }
  requireArrayIncludes(
    functionFeature?.entry_symbols,
    'json_stopless_center_persists_without_local_continuation_store',
    `${paths.functionMap} ${featureId}.entry_symbols`,
  );
}

function verifyMainlineOwnership() {
  const chains = Array.isArray(mainlineMap.chains) ? mainlineMap.chains : [];
  const stoplessChain = chains.find((chain) => chain?.chain_id === featureId);
  if (!stoplessChain) {
    fail(`${paths.mainlineMap}: missing chain ${featureId}`);
    return;
  }
  const stoplessEdges = Array.isArray(stoplessChain.edges) ? stoplessChain.edges : [];
  const readers = stoplessEdges.filter((edge) => edge?.resource_flow?.side_channel_reads?.includes(resourceId));
  const writers = stoplessEdges.filter((edge) => edge?.resource_flow?.side_channel_writes?.includes(resourceId));
  if (readers.length === 0) fail(`${featureId}: missing declared StoplessCenter read edge`);
  if (writers.length === 0) fail(`${featureId}: missing declared StoplessCenter write edge`);
  if (!readers.some((edge) => edge.step_id === 'v3-servertool-stopless-req-02')) {
    fail(`${featureId}: StoplessCenter load must bind to v3-servertool-stopless-req-02`);
  }
  if (!writers.some((edge) => edge.step_id === 'v3-servertool-stopless-resp-02')) {
    fail(`${featureId}: StoplessCenter update must bind to v3-servertool-stopless-resp-02`);
  }

  for (const chain of chains) {
    for (const edge of chain.edges ?? []) {
      const flow = edge.resource_flow ?? {};
      const accesses = [
        ...(flow.consumes ?? []),
        ...(flow.produces ?? []),
        ...(flow.side_channel_reads ?? []),
        ...(flow.side_channel_writes ?? []),
      ];
      if (accesses.includes(resourceId) && chain.chain_id !== featureId) {
        fail(`${edge.step_id}: undeclared cross-SOP StoplessCenter access outside ${featureId}`);
      }
      if (
        ['v3-responses-relay-server-02', 'v3-responses-relay-server-03'].includes(edge.step_id)
        && edge.edge_kind !== 'aggregate_entry_edge'
      ) {
        fail(`${edge.step_id}: server routing edge must be typed aggregate_entry_edge`);
      }
      if (
        ['v3-responses-relay-server-02', 'v3-responses-relay-server-03'].includes(edge.step_id)
        && (flow.side_channel_writes ?? []).length > 0
      ) {
        fail(`${edge.step_id}: aggregate server edge must not claim control/resource writes`);
      }
    }
  }
}

function verifyRuntimeSeparation() {
  const localExecution = extractBlock(
    runtimeSource,
    "struct V3ResponsesRelayLocalContinuationExecution<'state>",
    "struct V3ResponsesRelayStoplessControlExecution<'state>",
  );
  if (!localExecution) {
    fail(`${paths.runtime}: missing V3ResponsesRelayLocalContinuationExecution block`);
  } else if (localExecution.includes('stopless_control')) {
    fail(`${paths.runtime}: local continuation execution must not own stopless_control`);
  }
  const controlExecution = extractBlock(
    runtimeSource,
    "struct V3ResponsesRelayStoplessControlExecution<'state>",
    'async fn execute_v3_responses_relay_runtime_inner',
  );
  if (!controlExecution?.includes('V3ResponsesRelayStoplessControlState')) {
    fail(`${paths.runtime}: missing independent StoplessCenter control execution carrier`);
  }
  for (const helper of [
    'load_v3_responses_relay_stopless_control_state',
    'store_v3_responses_relay_stopless_control_state',
    'clear_v3_responses_relay_stopless_control_state',
  ]) {
    const signature = extractBlock(runtimeSource, `fn ${helper}(`, ') ->');
    if (!signature) fail(`${paths.runtime}: missing ${helper}`);
    else if (signature.includes('V3ResponsesRelayLocalContinuationExecution')) {
      fail(`${paths.runtime}: ${helper} must not accept local continuation execution`);
    } else if (!signature.includes('V3ResponsesRelayStoplessControlExecution')) {
      fail(`${paths.runtime}: ${helper} must accept independent StoplessCenter control execution`);
    }
  }
  requireTextIncludes(
    runtimeSource,
    'pub struct V3ResponsesRelayStoplessControlScope',
    paths.runtime,
  );
  requireTextIncludes(
    runtimeSource,
    'execute_v3_responses_relay_runtime_with_transport_health_and_stopless_control',
    paths.runtime,
  );
  requireTextIncludes(
    runtimeSource,
    'has_client_session_scope',
    `${paths.runtime} StoplessCenter session boundary`,
  );
  requireTextIncludes(
    runtimeSource,
    'session_id.starts_with("request:")',
    `${paths.runtime} StoplessCenter request-fallback scope guard`,
  );
  requireTextIncludes(
    readText('v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs'),
    'json_stopless_center_missing_client_session_scope_passes_stop_without_control_write',
    'StoplessCenter missing-session red/green test',
  );
}

function verifyStoplessStateMachineShape() {
  const stateBlock = extractBlock(
    hubSource,
    'pub struct V3StoplessCenterState {',
    '\n}',
  );
  if (!stateBlock) {
    fail(`${paths.hubCommon}: missing V3StoplessCenterState`);
    return;
  }
  for (const field of [
    'phase',
    'consecutive_stop_count',
    'max_stop_budget',
    'last_stop_kind',
    'need_continue',
    'blocked',
    'terminal',
    'guard_exhausted',
    'next_request_policy',
    'last_request_id',
    'last_response_id',
    'last_transition_reason',
    'updated_at',
  ]) {
    requireTextIncludes(stateBlock, field, `${paths.hubCommon} V3StoplessCenterState`);
  }
  const steeringBlock = extractBlock(
    hubSource,
    'pub enum V3StoplessCenterSteering {',
    '\n}',
  );
  if (!steeringBlock) {
    fail(`${paths.hubCommon}: missing V3StoplessCenterSteering`);
    return;
  }
  for (const variant of [
    'Continue',
    'Blocked',
    'NeedContinue',
    'GuardTerminal',
  ]) {
    requireTextIncludes(steeringBlock, variant, `${paths.hubCommon} V3StoplessCenterSteering`);
  }
}

function verifyCliProjection() {
  const commandBlock = extractBlock(
    hookSource,
    'fn build_stopless_cli_command() -> String {',
    '\n}',
  );
  if (!commandBlock) {
    fail(`${paths.hooks}: missing build_stopless_cli_command`);
    return;
  }
  requireTextIncludes(
    commandBlock,
    `"routecodex hook run reasoningStop"`,
    `${paths.hooks} build_stopless_cli_command`,
  );
  if (commandBlock.includes('--input-json')) {
    fail(`${paths.hooks}: reasoningStop CLI must be no-input and must not include --input-json`);
  }
  for (const forbidden of [
    'input-json',
    'session_id',
    'sessionId',
    'conversation_id',
    'conversationId',
    'request_id',
    'requestId',
    'repeatCount',
    'schemaFeedback',
    'runtime_control',
    'StoplessCenter',
  ]) {
    if (commandBlock.includes(forbidden)) {
      fail(`${paths.hooks}: reasoningStop CLI must not carry ${forbidden}`);
    }
  }
  if (/stdout|parse|from_str|serde_json/u.test(commandBlock)) {
    fail(`${paths.hooks}: reasoningStop CLI must not parse stdout/state JSON`);
  }
}

function verifyStoplessGuideline() {
  const baseInstruction = extractBlock(
    hookSource,
    'const STOPLESS_BASE_INSTRUCTION',
    'const STOPLESS_NOOP_CONTINUATION_GUIDELINE',
  );
  const continuationGuideline = extractBlock(
    hookSource,
    'const STOPLESS_NOOP_CONTINUATION_GUIDELINE',
    'pub struct V3StoplessResponseHookOutcome',
  );
  const stateGuidanceBuilders = extractBlock(
    hookSource,
    'fn stopless_instruction_for_state',
    'fn strip_legacy_stopless_instruction',
  );
  const providerVisibleGuidance = `${baseInstruction}\n${continuationGuideline}\n${stateGuidanceBuilders}`;
  if (!baseInstruction || !continuationGuideline || !stateGuidanceBuilders) {
    fail(`${paths.hooks}: cannot extract provider-visible stopless guideline blocks`);
  }
  for (const token of [
    'STOPLESS_NOOP_CONTINUATION_GUIDELINE',
    '当前轮继续推进准则',
    '继续当前目标',
    '基于已经恢复的完整上下文',
    '复核当前目标',
    '已有结论',
    '未完成事项',
    '继续推理',
    '按需调用可用工具',
    '不要只总结',
    '目标确实完成并有证据',
    'needs_user_input',
    '既未完成也未阻塞，继续工作',
    '更严格地推进',
    '当前完成/阻塞证据不足',
  ]) {
    requireTextIncludes(providerVisibleGuidance, token, `${paths.hooks} full transparent stopless continuation guideline`);
  }
  if (hookSource.includes('STOPLESS_NOOP_CONTINUATION_PROMPT: &str = "继续。"')) {
    fail(`${paths.hooks}: terse stopless continuation prompt must not be the request-side policy`);
  }
  for (const forbidden of [
    'RouteCodex stopless continuation',
    '上一轮 reasoningStop CLI',
    'no-op 只表示客户端工具轮',
    'no-op',
    'CLI',
    'client tool round',
    '客户端工具轮',
    'routecodex hook run reasoningStop',
    'finish_reason=stop',
    '不是工具结果',
    'blocked reason',
    '这是连续第',
    '最多',
    '续轮上限',
    '连续 stop 次数',
  ]) {
    if (providerVisibleGuidance.includes(forbidden)) {
      fail(`${paths.hooks}: provider-visible stopless guideline must not contain ${forbidden}`);
    }
  }
  for (const [label, feature] of [
    [paths.functionMap, (functionMap.features ?? []).find((candidate) => candidate?.feature_id === featureId)],
    [paths.verificationMap, (verificationMap.features ?? []).find((candidate) => candidate?.feature_id === featureId)],
  ]) {
    const serialized = YAML.stringify(feature ?? {});
    for (const token of ['complete non-persistent', 'guideline', '继续。', 'transparent']) {
      requireTextIncludes(serialized, token, `${label} ${featureId} guideline contract`);
    }
  }
}

function verifySnapshotBoundary() {
  for (const token of [
    'diagnostic correlation only',
    'L8 observability/debug',
    'L5 Metadata Center',
    'must never restore or own StoplessCenter control truth',
  ]) {
    requireTextIncludes(snapshotContract, token, paths.snapshotContract);
  }
  for (const [rel, source] of [
    [paths.runtime, runtimeSource],
    ['v3/crates/routecodex-v3-debug/src/lib.rs', readText('v3/crates/routecodex-v3-debug/src/lib.rs')],
  ]) {
    const forbidden = [
      /(?:restore|hydrate|rebuild|load)[A-Za-z0-9_\s]*(?:stopless|StoplessCenter)[A-Za-z0-9_\s]*(?:snapshot|debug|runtime_json)/u,
      /(?:snapshot|debug|runtime_json)[A-Za-z0-9_\s]*(?:restore|hydrate|rebuild|load)[A-Za-z0-9_\s]*(?:stopless|StoplessCenter)/u,
    ];
    if (forbidden.some((pattern) => pattern.test(source))) {
      fail(`${rel}: snapshot/debug artifacts must not restore StoplessCenter control truth`);
    }
  }
}

function extractBlock(source, start, end) {
  const startIndex = source.indexOf(start);
  if (startIndex < 0) return '';
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (endIndex < 0) return '';
  return source.slice(startIndex, endIndex + end.length);
}
