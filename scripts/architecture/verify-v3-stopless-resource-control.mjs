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
  designContract: 'docs/design/v3-stopless-schema-guidance-activation-contract.md',
  stoplessSop: '.agents/skills/rcc-dev-skills/references/95-v3-stopless-sop.md',
  hub: 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
  hubCommon: 'v3/crates/routecodex-v3-runtime/src/hub_v1/common.rs',
  runtime: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
  directRuntime: 'v3/crates/routecodex-v3-runtime/src/kernel.rs',
  directState: 'v3/crates/routecodex-v3-runtime/src/kernel/direct_state.rs',
  directStopless: 'v3/crates/routecodex-v3-runtime/src/kernel/direct_stopless.rs',
  directHelpers: 'v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers.rs',
  hooks: 'v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs',
  reqInbound: 'v3/crates/routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs',
  reqOutbound: 'v3/crates/routecodex-v3-runtime/src/hub_v1/req_outbound_07_provider_semantic.rs',
  respChatProcess:
    'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs',
  respContinuation:
    'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs',
  packageJson: 'package.json',
};

const resourceId = 'v3.metadata.runtime_control_stopless';
const featureId = 'v3.servertool_hook_skeleton_lifecycle';
const directFeatureId = 'v3.direct_stopless_metadata_center';
const allowedStoplessChainIds = new Set([featureId, directFeatureId]);
const verifyGate = 'npm run verify:v3-stopless-resource-control';
const redGate = 'npm run test:v3-stopless-resource-control-red-fixtures';
const cliGate = 'npm run jest:run -- --runTestsByPath tests/cli/servertool-command.spec.ts';

const resourceMap = readYaml(paths.resourceMap);
const functionMap = readYaml(paths.functionMap);
const mainlineMap = readYaml(paths.mainlineMap);
const verificationMap = readYaml(paths.verificationMap);
const manifest = readYaml(paths.manifest);
const snapshotContract = readText(paths.snapshotContract);
const designContract = readText(paths.designContract);
const stoplessSop = readText(paths.stoplessSop);
const hubSource = [readText(paths.hub), readText(paths.hubCommon)].join('\n');
const runtimeSource = readText(paths.runtime);
const directRuntimeSource = [
  readText(paths.directRuntime),
  readText(paths.directState),
  readText(paths.directStopless),
  readText(paths.directHelpers),
].join('\n');
const hookSource = readText(paths.hooks);
const reqInboundSource = readText(paths.reqInbound);
const reqOutboundSource = readText(paths.reqOutbound);
const respChatProcessSource = readText(paths.respChatProcess);
const respContinuationSource = readText(paths.respContinuation);
const packageJson = readJson(paths.packageJson);

verifyPackageScripts();
verifyResourceOwner();
verifyLifecycleManifest();
verifyFunctionAndVerificationMaps();
verifyMainlineOwnership();
verifyRuntimeSeparation();
verifyDirectRuntimeSeparation();
verifyStoplessStateMachineShape();
verifyCliProjection();
verifyStoplessGuideline();
verifyActivationContract();
verifySnapshotBoundary();

if (failures.length > 0) {
  console.error('[verify:v3-stopless-resource-control] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:v3-stopless-resource-control] ok');
console.log('- StoplessCenter semantic owner: Metadata Center / StoplessCenterMetadataControl');
console.log('- CLI projection: no-input no-op, no scope/state/envelope');
console.log('- resource access: declared Relay/Direct Stopless SOP edges only');
console.log('- Direct adapter: V3ResponsesDirectStoplessControlState (direct_scoped_only)');

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
    'next_step_prompt',
    'last_request_id',
    'last_response_id',
    'last_transition_reason',
    'updated_at',
  ]) {
    requireArrayIncludes(resource.state_fields, field, `${resourceId}.state_fields`);
  }
  requireEqual(resource.data_control_separation, 'required', `${resourceId}.data_control_separation`);
  requireEqual(resource.normal_payload_state, 'forbidden', `${resourceId}.normal_payload_state`);
  requireEqual(
    resource.current_turn_protocol_projection?.req04_injection,
    'allowed_registered_only',
    `${resourceId}.current_turn_protocol_projection.req04_injection`,
  );
  requireEqual(
    resource.current_turn_protocol_projection?.resp03_stripping,
    'allowed_matching_provenance_only',
    `${resourceId}.current_turn_protocol_projection.resp03_stripping`,
  );
  requireEqual(
    resource.current_turn_protocol_projection?.history_mutation,
    'forbidden',
    `${resourceId}.current_turn_protocol_projection.history_mutation`,
  );
  requireEqual(
    resource.current_turn_protocol_projection?.continuation_immutable_interval_semantics,
    'forbidden',
    `${resourceId}.current_turn_protocol_projection.continuation_immutable_interval_semantics`,
  );
  requireEqual(resource.may_enter_provider_body, false, `${resourceId}.may_enter_provider_body`);
  requireEqual(resource.may_enter_client_body, false, `${resourceId}.may_enter_client_body`);

  const handles = Array.isArray(resource.implementation_handles) ? resource.implementation_handles : [];
  if (!handles.some((handle) => String(handle).startsWith('V3ResponsesRelayStoplessControlState'))) {
    fail(`${resourceId}.implementation_handles must classify V3ResponsesRelayStoplessControlState as an adapter handle`);
  }
  if (!handles.some((handle) => String(handle).startsWith('V3ResponsesDirectStoplessControlState'))) {
    fail(`${resourceId}.implementation_handles must classify V3ResponsesDirectStoplessControlState as an adapter handle`);
  }
  for (const writer of [
    'V3ResponsesDirectStoplessControlState::store_for_scope',
    'V3ResponsesDirectStoplessControlState::clear_for_scope',
    'prepare_v3_responses_direct_stopless_control_request',
    'apply_v3_responses_direct_stopless_json_response_control',
    'V3DirectStoplessResp02RuntimeControlUpdated',
  ]) {
    requireArrayIncludes(resource.allowed_writers, writer, `${resourceId}.allowed_writers`);
  }
  if (resource.allowed_writers?.includes('wrap_direct_sse_stopless_control_stream')) {
    fail(`${resourceId}.allowed_writers must not include removed SSE stream wrapper`);
  }
  for (const reader of [
    'V3ResponsesDirectStoplessControlState::load_for_scope',
    'prepare_v3_responses_direct_stopless_control_request',
    'V3DirectStoplessReq01RuntimeControlLoaded',
  ]) {
    requireArrayIncludes(resource.allowed_readers, reader, `${resourceId}.allowed_readers`);
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
    'next_step_prompt',
    'last_request_id',
    'last_response_id',
    'last_transition_reason',
    'updated_at',
  ]) {
    requireArrayIncludes(owner.state_fields, field, `${paths.manifest}.control_owner.state_fields`);
  }
  requireEqual(owner.data_control_separation, 'required', `${paths.manifest}.control_owner.data_control_separation`);
  requireEqual(owner.normal_payload_state, 'forbidden', `${paths.manifest}.control_owner.normal_payload_state`);
  const currentTurnProjection = manifest.current_turn_protocol_projection ?? {};
  requireEqual(
    currentTurnProjection.req04_injection,
    'allowed_registered_only',
    `${paths.manifest}.current_turn_protocol_projection.req04_injection`,
  );
  requireEqual(
    currentTurnProjection.resp03_stripping,
    'allowed_matching_provenance_only',
    `${paths.manifest}.current_turn_protocol_projection.resp03_stripping`,
  );
  for (const key of ['request_id', 'scope', 'registered_declaration', 'call_identity']) {
    requireArrayIncludes(
      currentTurnProjection.provenance_keys,
      key,
      `${paths.manifest}.current_turn_protocol_projection.provenance_keys`,
    );
  }
  requireEqual(
    currentTurnProjection.history_mutation,
    'forbidden',
    `${paths.manifest}.current_turn_protocol_projection.history_mutation`,
  );
  requireEqual(
    currentTurnProjection.continuation_immutable_interval_semantics,
    'forbidden',
    `${paths.manifest}.current_turn_protocol_projection.continuation_immutable_interval_semantics`,
  );
  requireEqual(
    currentTurnProjection.stopless_center_state_in_payload,
    'forbidden',
    `${paths.manifest}.current_turn_protocol_projection.stopless_center_state_in_payload`,
  );
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
  const activation = manifest.activation_contract ?? {};
  requireEqual(activation.design_doc, paths.designContract, `${paths.manifest}.activation_contract.design_doc`);
  requireEqual(activation.request_schema_guidance_required, true, `${paths.manifest}.activation_contract.request_schema_guidance_required`);
  requireEqual(activation.activation_truth_owner, 'metadata_center_stopless_state_machine', `${paths.manifest}.activation_contract.activation_truth_owner`);
  requireEqual(activation.loose_activation_marker, 'forbidden', `${paths.manifest}.activation_contract.loose_activation_marker`);
  for (const field of ['schema_guidance_active', 'schema_guidance_request_id', 'schema_guidance_contract']) {
    requireArrayIncludes(activation.activation_state_fields, field, `${paths.manifest}.activation_contract.activation_state_fields`);
  }
  requireEqual(activation.response_intercept_without_activation, 'forbidden', `${paths.manifest}.activation_contract.response_intercept_without_activation`);
  requireEqual(activation.no_activation_policy, 'pass_through_without_stopless_projection_or_state_write', `${paths.manifest}.activation_contract.no_activation_policy`);
  requireEqual(activation.missing_summary_and_schema, 'continue_when_activated', `${paths.manifest}.activation_contract.missing_summary_and_schema`);
  requireEqual(activation.unfinished_schema, 'continue_when_activated', `${paths.manifest}.activation_contract.unfinished_schema`);
  requireEqual(activation.visible_or_fenced_schema_truth, 'forbidden', `${paths.manifest}.activation_contract.visible_or_fenced_schema_truth`);
  requireEqual(activation.provider_validation_exception, 'disable_activation_when_guidance_injection_is_provider_invalid', `${paths.manifest}.activation_contract.provider_validation_exception`);
  requireEqual(activation.relay_stopless_center_write, 'relay_only', `${paths.manifest}.activation_contract.relay_stopless_center_write`);
  requireEqual(activation.direct_stopless_center_write, 'direct_scoped_only', `${paths.manifest}.activation_contract.direct_stopless_center_write`);
  requireArrayIncludes(activation.terminal_reasons_only, 'stop', `${paths.manifest}.activation_contract.terminal_reasons_only`);
  requireArrayIncludes(activation.terminal_reasons_only, 'end_turn', `${paths.manifest}.activation_contract.terminal_reasons_only`);
  requireArrayIncludes(activation.accepted_stop_evidence, 'canonical_reasoning_summary', `${paths.manifest}.activation_contract.accepted_stop_evidence`);
  requireArrayIncludes(activation.accepted_stop_evidence, 'accepted_stop_schema', `${paths.manifest}.activation_contract.accepted_stop_evidence`);
  requireArrayIncludes(activation.provider_validation_exception_provider_family, 'anthropic', `${paths.manifest}.activation_contract.provider_validation_exception_provider_family`);
  requireArrayIncludes(activation.applies_to_paths, 'responses_direct', `${paths.manifest}.activation_contract.applies_to_paths`);
  requireArrayIncludes(activation.applies_to_paths, 'responses_relay', `${paths.manifest}.activation_contract.applies_to_paths`);
}

function verifyFunctionAndVerificationMaps() {
  const functionFeature = (functionMap.features ?? []).find((candidate) => candidate?.feature_id === featureId);
  const verificationFeature = (verificationMap.features ?? []).find((candidate) => candidate?.feature_id === featureId);
  const directFunctionFeature = (functionMap.features ?? []).find((candidate) => candidate?.feature_id === directFeatureId);
  const directVerificationFeature = (verificationMap.features ?? []).find((candidate) => candidate?.feature_id === directFeatureId);
  if (!functionFeature) fail(`${paths.functionMap}: missing feature ${featureId}`);
  if (!verificationFeature) fail(`${paths.verificationMap}: missing feature ${featureId}`);
  if (!directFunctionFeature) fail(`${paths.functionMap}: missing feature ${directFeatureId}`);
  if (!directVerificationFeature) fail(`${paths.verificationMap}: missing feature ${directFeatureId}`);
  for (const symbol of [
    'V3ResponsesDirectStoplessControlState',
    'prepare_v3_responses_direct_stopless_control_request',
    'apply_v3_responses_direct_stopless_json_response_control',
    'direct_json_stopless_metadata_center_projects_noop_and_continues_on_remote_direct_locator',
  ]) {
    requireArrayIncludes(directFunctionFeature?.entry_symbols, symbol, `${paths.functionMap} ${directFeatureId}.entry_symbols`);
  }
  if (directFunctionFeature?.entry_symbols?.includes('wrap_direct_sse_stopless_control_stream')) {
    fail(`${paths.functionMap} ${directFeatureId}.entry_symbols must not include removed SSE stream wrapper`);
  }
  requireArrayIncludes(directFunctionFeature?.required_gates, verifyGate, `${paths.functionMap} ${directFeatureId}.required_gates`);
  requireArrayIncludes(directVerificationFeature?.required_gates, verifyGate, `${paths.verificationMap} ${directFeatureId}.required_gates`);
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
      'schema_guidance_active',
      'inactive state',
      'data/control',
      'normal payload',
      'CLI',
      'continuation',
      'debug/snapshot',
      'declared',
      'SOP',
      'accepted canonical summary',
      'accepted_stop_schema',
      'Anthropic',
    ]) {
      if (!serializedLower.includes(token.toLowerCase().replace(/\s+/gu, ' '))) {
        fail(`${label} ${featureId} missing ${token}`);
      }
    }
    requireArrayIncludes(feature.required_gates, verifyGate, `${label} ${featureId}.required_gates`);
    requireArrayIncludes(feature.required_gates, redGate, `${label} ${featureId}.required_gates`);
    requireArrayIncludes(feature.required_gates, cliGate, `${label} ${featureId}.required_gates`);
    const designRefs = [...(feature.design ?? []), ...(feature.owner_files ?? []), ...(feature.allowed_paths ?? [])];
    requireArrayIncludes(designRefs, paths.designContract, `${label} ${featureId}.design/owner_files/allowed_paths`);
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

  const directChain = chains.find((chain) => chain?.chain_id === directFeatureId);
  if (!directChain) {
    fail(`${paths.mainlineMap}: missing chain ${directFeatureId}`);
  } else {
    const directEdges = Array.isArray(directChain.edges) ? directChain.edges : [];
    const directReaders = directEdges.filter((edge) => edge?.resource_flow?.side_channel_reads?.includes(resourceId));
    const directWriters = directEdges.filter((edge) => edge?.resource_flow?.side_channel_writes?.includes(resourceId));
    if (directReaders.length === 0) fail(`${directFeatureId}: missing declared Direct StoplessCenter read edge`);
    if (directWriters.length === 0) fail(`${directFeatureId}: missing declared Direct StoplessCenter write edge`);
    if (!directReaders.some((edge) => edge.step_id === 'v3-direct-stopless-req-01')) {
      fail(`${directFeatureId}: StoplessCenter load must bind to v3-direct-stopless-req-01`);
    }
    if (!directWriters.some((edge) => edge.step_id === 'v3-direct-stopless-resp-02')) {
      fail(`${directFeatureId}: StoplessCenter update must bind to v3-direct-stopless-resp-02`);
    }
    if (JSON.stringify(directChain).includes('wrap_direct_sse_stopless_control_stream')) {
      fail(`${directFeatureId} must not declare the removed SSE stream wrapper`);
    }
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
      if (accesses.includes(resourceId) && !allowedStoplessChainIds.has(chain.chain_id)) {
        fail(`${edge.step_id}: undeclared cross-SOP StoplessCenter access outside ${[...allowedStoplessChainIds].join('|')}`);
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
  const resp03Node = extractBlock(
    respChatProcessSource,
    'pub struct V3HubRespChatProcess03Governed {',
    '\n}',
  );
  if (resp03Node?.includes('V3StoplessCenterState')) {
    fail(`${paths.respChatProcess}: Resp03 data node must not carry StoplessCenter control state`);
  }
  const resp04Node = extractBlock(
    respContinuationSource,
    'pub struct V3HubRespContinuation04Committed {',
    '\n}',
  );
  if (resp04Node?.includes('V3StoplessCenterState')) {
    fail(`${paths.respContinuation}: Resp04 continuation data node must not carry StoplessCenter control state`);
  }
  if (!respChatProcessSource.includes('pub struct V3HubRespChatProcess03Outcome')) {
    fail(`${paths.respChatProcess}: missing typed Resp03 data/control outcome`);
  }
  if (!respContinuationSource.includes('pub struct V3HubRespContinuation04Outcome')) {
    fail(`${paths.respContinuation}: missing typed Resp04 data/control outcome`);
  }
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

function verifyDirectRuntimeSeparation() {
  for (const token of [
    'pub struct V3ResponsesDirectStoplessControlScope',
    'pub struct V3ResponsesDirectStoplessControlState',
    'pub fn load_for_scope(',
    'fn prepare_v3_responses_direct_stopless_control_request(',
    'fn apply_v3_responses_direct_stopless_json_response_control(',
    'fn apply_v3_responses_direct_stopless_control_request_transition(',
    'fn apply_v3_responses_direct_stopless_control_response_transition(',
    'V3DirectStoplessReq01RuntimeControlLoaded',
    'V3DirectStoplessResp02RuntimeControlUpdated',
    'has_client_session_scope',
    'session_id.starts_with("request:")',
  ]) {
    requireTextIncludes(directRuntimeSource, token, `${paths.directRuntime}`);
  }
  for (const removed of ['fn wrap_direct_sse_stopless_control_stream(', 'fn commit_v3_direct_stopless_remote_locator_for_payload(']) {
    if (directRuntimeSource.includes(removed)) {
      fail(`${paths.directRuntime} must not contain removed ${removed.trim()}`);
    }
  }
  // Direct must not write Relay StoplessCenter handle.
  if (directRuntimeSource.includes('V3ResponsesRelayStoplessControlState')) {
    fail(`${paths.directRuntime}: Direct stopless control must not reference Relay StoplessCenter handle`);
  }
  requireTextIncludes(
    readText('v3/crates/routecodex-v3-runtime/tests/responses_direct_remote_continuation_integration.rs'),
    'direct_json_stopless_metadata_center_projects_noop_and_continues_on_remote_direct_locator',
    'Direct StoplessCenter positive test',
  );
  requireTextIncludes(
    readText('v3/crates/routecodex-v3-runtime/tests/responses_direct_remote_continuation_integration.rs'),
    'direct_sse_stopless_metadata_center_projects_terminal_frames_without_sse_owning_semantics',
    'Direct SSE StoplessCenter positive test',
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
    'next_step_prompt',
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
  for (const forbidden of [
    'fn build_stopless_cli_command() -> String {',
    'fn build_stopless_cli_projection_payload(',
  ]) {
    if (hookSource.includes(forbidden)) {
      fail(`${paths.hooks}: stopless control CLI projection must not enter client business payload via ${forbidden}`);
    }
  }
}

function verifyStoplessGuideline() {
  for (const token of [
    'inject_stopless_guidance(',
    'append_stopless_noop_continuation(',
    'stopless_continuation_prompt_for_state(',
    'build_reasoning_stop_tool(',
    'STOPLESS_BASE_INSTRUCTION',
    'STOPLESS_NOOP_CONTINUATION_GUIDELINE',
  ]) {
    for (const [rel, source] of [
      [paths.reqInbound, reqInboundSource],
      [paths.reqOutbound, reqOutboundSource],
      [paths.respContinuation, respContinuationSource],
    ]) {
      if (source.includes(token)) {
        fail(`${rel}: Stopless current-turn projection must remain owned by Req04/Resp03, found ${token}`);
      }
    }
  }
}

function verifyActivationContract() {
  for (const [rel, source] of [
    [paths.designContract, designContract],
    [paths.stoplessSop, stoplessSop],
  ]) {
    for (const token of [
      'same-turn schema guidance',
      'activation marker',
      'stop/end_turn',
      'canonical reasoning `summary`',
      'stop_schema',
      'No activation',
      'Anthropic',
      'direct',
      'relay',
    ]) {
      requireTextIncludes(source, token, rel);
    }
    for (const forbidden of [
      'without activation projects no-op',
      'no marker projects no-op',
      'visible text is accepted evidence',
      'fenced JSON is accepted evidence',
    ]) {
      if (source.includes(forbidden)) fail(`${rel}: activation contract must not allow ${forbidden}`);
    }
  }
  for (const [label, feature] of [
    [paths.functionMap, (functionMap.features ?? []).find((candidate) => candidate?.feature_id === featureId)],
    [paths.verificationMap, (verificationMap.features ?? []).find((candidate) => candidate?.feature_id === featureId)],
  ]) {
    const serialized = YAML.stringify(feature ?? {});
    for (const token of [
      'schema_guidance_active',
      'inactive state',
      'accepted canonical summary',
      'accepted_stop_schema',
      'without CLI projection',
      'Anthropic',
      'StoplessCenter',
    ]) {
      requireTextIncludes(serialized, token, `${label} ${featureId} activation contract`);
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
