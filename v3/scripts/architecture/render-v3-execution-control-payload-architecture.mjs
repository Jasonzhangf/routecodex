#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const check = process.argv.includes('--check');
const manifestRel = 'docs/architecture/manifests/v3.execution_control_payload_architecture.mainline.yml';
const resourceMapRel = 'docs/architecture/v3-resource-operation-map.yml';
const functionMapRel = 'docs/architecture/v3-function-map.yml';
const callMapRel = 'docs/architecture/v3-mainline-call-map.yml';
const moduleRegistryRel = 'docs/architecture/v3-runtime-module-registry.yml';
const verificationMapRel = 'docs/architecture/v3-verification-map.yml';
const packageRel = 'v3/package.json';
const runtimeSourceRootRel = 'v3/crates/routecodex-v3-runtime/src';
const runtimeExecutionControlRel = `${runtimeSourceRootRel}/execution_control.rs`;
const runtimeNodesRel = `${runtimeSourceRootRel}/nodes.rs`;
const providerFailurePolicyRel = `${runtimeSourceRootRel}/provider_failure_runtime_policy.rs`;
const directContinuationCommitRel = `${runtimeSourceRootRel}/kernel/direct_continuation_commit.rs`;
const directKernelRel = `${runtimeSourceRootRel}/kernel.rs`;
const directCoreRel = `${runtimeSourceRootRel}/kernel/v3_direct_core.rs`;
const responsesRelayRuntimeRel = `${runtimeSourceRootRel}/hub_v1/responses_relay_runtime.rs`;
const responsesRelayRuntimeInnerRel = `${runtimeSourceRootRel}/hub_v1/responses_relay_runtime_inner.rs`;
const responsesRelayTypesRel = `${runtimeSourceRootRel}/hub_v1/responses_relay_types.rs`;
const responsesRelayFailuresRel = `${runtimeSourceRootRel}/hub_v1/responses_relay_failures.rs`;
const responsesRelayDryRunRel = `${runtimeSourceRootRel}/hub_v1/responses_relay_dry_run.rs`;
const anthropicRelayRuntimeRel = `${runtimeSourceRootRel}/hub_v1/anthropic_relay_runtime.rs`;
const anthropicRelayRuntimeHelpersRel = `${runtimeSourceRootRel}/hub_v1/anthropic_relay_runtime_helpers.rs`;
const providerHealthStateRel = 'v3/crates/routecodex-v3-provider-responses/src/health.rs';
const providerHealthPersistenceRel = 'v3/crates/routecodex-v3-provider-responses/src/health/persistence.rs';
const webuiObservabilityRel = 'v3/crates/routecodex-v3-server/src/webui_observability.rs';
const observabilityStoreRel = 'v3/crates/routecodex-v3-debug/src/observability_store.rs';
const configLibRel = 'v3/crates/routecodex-v3-config/src/lib.rs';
const configAttemptStoreRel = 'v3/crates/routecodex-v3-config/src/attempt_store.rs';
const configTypesRel = 'v3/crates/routecodex-v3-config/src/types.rs';
const configValidateRel = 'v3/crates/routecodex-v3-config/src/validate.rs';
const serverLibRel = 'v3/crates/routecodex-v3-server/src/lib.rs';
const serverExecutorsRel = 'v3/crates/routecodex-v3-server/src/executors.rs';
const failures = [];

const readText = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const readYaml = (rel) => YAML.parse(readText(rel)) ?? {};
const array = (value) => Array.isArray(value) ? value : [];
const requireValue = (condition, message) => { if (!condition) failures.push(message); };

const manifest = readYaml(manifestRel);
const resourceMap = readYaml(resourceMapRel);
const functionMap = readYaml(functionMapRel);
const callMap = readYaml(callMapRel);
const moduleRegistry = readYaml(moduleRegistryRel);
const verificationMap = readYaml(verificationMapRel);
const packageJson = JSON.parse(readText(packageRel));

validateContracts();
const markdown = renderMarkdown();
const html = renderHtml();

if (failures.length === 0) {
  writeOrCompare(manifest.generated_docs.markdown, markdown);
  writeOrCompare(manifest.generated_docs.html, html);
}

if (failures.length > 0) {
  console.error('[render:v3-execution-control-payload-architecture] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  if (check) console.error('- run `npm run render:v3-execution-control-payload-architecture`');
  process.exit(1);
}

console.log(check
  ? '[verify:v3-execution-control-payload-architecture] ok'
  : '[render:v3-execution-control-payload-architecture] ok');
console.log(`- markdown ${manifest.generated_docs.markdown}`);
console.log(`- html ${manifest.generated_docs.html}`);

function validateContracts() {
  requireValue(manifest.lifecycle_id === 'v3.execution_control_payload_architecture', `${manifestRel}: lifecycle_id mismatch`);
  requireValue(manifest.status === 'active', `${manifestRel}: lifecycle status must be active`);
  requireValue(manifest.owner_feature_id === 'v3.execution_request_lifecycle', `${manifestRel}: owner_feature_id mismatch`);
  requireValue(array(manifest.current_runtime_red_bindings).length === 0, `${manifestRel}: current runtime-red bindings must be empty`);
  requireValue(manifest.entrypoint?.call_map_chain_id === manifest.lifecycle_id, `${manifestRel}: call-map chain mismatch`);
  const expectedImplementationOwners = {
    request_execution_control: runtimeExecutionControlRel,
    attempt_store_policy: configAttemptStoreRel,
    provider_health_persistence: providerHealthPersistenceRel,
  };
  for (const [owner, rel] of Object.entries(expectedImplementationOwners)) {
    requireValue(manifest.implementation_owner_files?.[owner] === rel, `${manifestRel}: ${owner} owner mismatch`);
  }
  requireValue(manifest.budget_contract?.reserve_before_append_or_copy === true, `${manifestRel}: reserve-before-append required`);
  requireValue(manifest.budget_contract?.provider_attempt_and_client_replay_share_request_budget === true, `${manifestRel}: provider attempt and client replay must share one request budget`);
  requireValue(manifest.budget_contract?.server_budget_construction === 'forbidden', `${manifestRel}: Server budget construction must be forbidden`);
  requireValue(manifest.budget_contract?.disk_spill === 'forbidden', `${manifestRel}: initial disk spill must be forbidden`);
  requireValue(manifest.sealed_replay_body_contract?.anthropic === 'typed_non_optional', `${manifestRel}: Anthropic sealed replay body must be typed and non-optional`);
  requireValue(manifest.sealed_replay_body_contract?.server_consumption === 'exhaustive_match', `${manifestRel}: Server sealed replay consumption must be exhaustive`);
  requireValue(manifest.sealed_replay_body_contract?.option_stream_with_expect === 'forbidden', `${manifestRel}: optional sealed replay plus expect must be forbidden`);
  for (const dimension of ['per_attempt', 'per_request', 'process_global', 'residence_or_deadline']) {
    requireValue(manifest.budget_contract?.[dimension] === 'required', `${manifestRel}: missing budget ${dimension}`);
  }
  for (const kind of ['Upstream', 'Protocol', 'LocalResourceExhausted', 'ObservationFailure', 'PersistenceFailure', 'ClientCancelled']) {
    requireValue(array(manifest.failure_kinds).includes(kind), `${manifestRel}: missing failure kind ${kind}`);
  }
  const responsesReplayFailure = manifest.failure_attribution_contract?.responses_client_replay;
  requireValue(responsesReplayFailure?.runtime_variant === 'ExecutionControlResponse', `${manifestRel}: Responses replay failure variant mismatch`);
  requireValue(responsesReplayFailure?.source_kind === 'RuntimeFailure' && responsesReplayFailure?.source_stage === 'V3ServerRespOutbound06ClientFrame', `${manifestRel}: Responses replay failure source attribution mismatch`);
  requireValue(responsesReplayFailure?.client_status === 599 && responsesReplayFailure?.client_code === 'responses_relay_response_execution_control_error', `${manifestRel}: Responses replay failure client projection mismatch`);
  requireValue(responsesReplayFailure?.provider_response_classification === 'forbidden' && responsesReplayFailure?.provider_health_mutation === 'forbidden', `${manifestRel}: Responses replay failure must remain provider-health neutral`);
  for (const forbidden of ['temporary_runtime', 'stream_wrapper_executor_reentry', 'route_pool_rehit', 'payload_control_reconstruction']) {
    requireValue(array(manifest.module_contracts?.runtime?.forbids).includes(forbidden), `${manifestRel}: runtime forbidden contract missing ${forbidden}`);
  }
  const resourceIds = new Set(array(resourceMap.resources).map((row) => row?.resource_id));
  for (const id of [
    ...array(manifest.control_resources),
    ...array(manifest.payload_resources),
    ...array(manifest.diagnostic_resources),
    ...array(manifest.persistence_resources),
  ]) requireValue(resourceIds.has(id), `${resourceMapRel}: missing manifest resource ${id}`);
  const targetFeatureIds = [
    'v3.execution_request_lifecycle',
    'v3.execution_attempt_budget_store',
    'v3.execution_attempt_success_receipt',
    'v3.execution_stream_control_diagnostics_split',
    'v3.provider_health_persistence_isolation',
    'v3.observability_persistence_isolation',
  ];
  for (const id of targetFeatureIds) {
    const feature = array(functionMap.features).find((row) => row?.feature_id === id);
    requireValue(Boolean(feature), `${functionMapRel}: missing feature ${id}`);
    requireValue(feature?.status === 'active', `${functionMapRel}: feature ${id} must be active`);
  }
  const chain = array(callMap.chains).find((row) => row?.chain_id === manifest.lifecycle_id);
  requireValue(Boolean(chain), `${callMapRel}: missing chain ${manifest.lifecycle_id}`);
  const callEdges = new Map(array(chain?.edges).map((row) => [row?.step_id, row]));
  for (const edge of array(manifest.edges)) {
    requireValue(edge?.status === 'active', `${manifestRel}: edge ${edge?.step_id} must be active`);
    const bound = callEdges.get(edge.step_id);
    requireValue(Boolean(bound), `${callMapRel}: missing edge ${edge.step_id}`);
    requireValue(bound?.from_node === edge.from_node && bound?.to_node === edge.to_node, `${callMapRel}: edge endpoints drift ${edge.step_id}`);
    requireValue(['active', 'anchored'].includes(bound?.status), `${callMapRel}: edge ${edge.step_id} must be active or anchored`);
  }
  for (const id of ['v3.execution_control_payload.runtime', 'v3.execution_control_payload.provider_responses', 'v3.execution_control_payload.server', 'v3.execution_control_payload.config']) {
    const contract = array(moduleRegistry.responsibility_contracts).find((row) => row?.contract_id === id);
    requireValue(Boolean(contract), `${moduleRegistryRel}: missing responsibility ${id}`);
    requireValue(contract?.binding_status === 'active', `${moduleRegistryRel}: responsibility ${id} must be active`);
  }
  const verificationFeature = array(verificationMap.features).find((row) => row?.feature_id === 'v3.execution_control_payload_architecture');
  requireValue(Boolean(verificationFeature), `${verificationMapRel}: missing verification feature`);
  requireValue(verificationFeature?.status === 'active', `${verificationMapRel}: verification feature must be active`);
  const targetMapText = [resourceMapRel, functionMapRel, callMapRel, moduleRegistryRel, verificationMapRel]
    .map((rel) => readText(rel))
    .join('\n');
  for (const removed of [
    'V3DirectSseAttemptBuffer',
    'wrap_direct_sse_provider_handoff_stream_with_observation',
    'execute_v3_responses_direct_runtime_kernel_core_with_handoff_budget',
  ]) requireValue(!targetMapText.includes(removed), `target architecture maps retain removed symbol ${removed}`);
  for (const gate of ['npm run verify:v3-execution-control-payload-architecture', 'npm run test:v3-execution-control-payload-architecture-red-fixtures']) {
    requireValue(array(manifest.verification_gates).includes(gate), `${manifestRel}: missing gate ${gate}`);
  }
  const scripts = packageJson.scripts ?? {};
  requireValue(scripts['render:v3-execution-control-payload-architecture'] === 'node scripts/architecture/render-v3-execution-control-payload-architecture.mjs', `${packageRel}: render script mismatch`);
  requireValue(scripts['verify:v3-execution-control-payload-architecture'] === 'node scripts/architecture/verify-v3-execution-control-payload-architecture.mjs', `${packageRel}: verify script mismatch`);
  requireValue(scripts['test:v3-execution-control-payload-architecture-red-fixtures'] === 'node scripts/tests/v3-execution-control-payload-architecture-red-fixtures.mjs', `${packageRel}: red-fixture script mismatch`);
  requireValue(String(scripts['verify:v3-architecture-docs'] ?? '').includes('verify:v3-execution-control-payload-architecture'), `${packageRel}: architecture docs gate must include execution-control verifier`);
  validateSuccessReceiptSource();
  validateRuntimeIsolationSource();
}

function validateSuccessReceiptSource() {
  const executionControl = readText(runtimeExecutionControlRel);
  const nodes = readText(runtimeNodesRel);
  requireValue(executionControl.includes('pub struct V3AttemptSuccessReceipt {\n    _runtime_sealed: (),\n}'), `${runtimeExecutionControlRel}: success receipt field must remain private`);
  for (const constructor of ['from_buffered_terminal_attempt', 'from_sealed_sse_attempt', 'from_protocol_terminal_attempt']) {
    requireValue(executionControl.includes(`pub(crate) fn ${constructor}`), `${runtimeExecutionControlRel}: success receipt constructor ${constructor} must remain crate-private`);
    requireValue(!executionControl.includes(`pub fn ${constructor}`), `${runtimeExecutionControlRel}: success receipt constructor ${constructor} must not be public`);
  }
  requireValue(nodes.includes('pub use crate::execution_control::{'), `${runtimeNodesRel}: execution-control compatibility re-export missing`);
  requireValue(!nodes.includes('pub struct V3AttemptSuccessReceipt {'), `${runtimeNodesRel}: aggregate nodes module must not own the success receipt implementation`);

  const owners = new Set(array(manifest.success_receipt_contract?.source_owner_files));
  for (const rel of rustFiles(path.join(repoRoot, runtimeSourceRootRel))) {
    const source = readText(rel);
    if (source.includes('V3AttemptSuccessReceipt::from_')) {
      requireValue(owners.has(rel), `${rel}: success receipt constructor used outside registered terminal/seal owner`);
    }
  }

  const providerFailurePolicy = readText(providerFailurePolicyRel);
  requireValue(
    /fn record_provider_success_in_failure_scope\([\s\S]{0,180}&crate::nodes::V3AttemptSuccessReceipt/u.test(providerFailurePolicy),
    `${providerFailurePolicyRel}: provider health success must require success receipt`,
  );
  const directContinuationCommit = readText(directContinuationCommitRel);
  requireValue(
    /fn commit_or_release_v3_direct_continuation\([\s\S]{0,120}&V3AttemptSuccessReceipt/u.test(directContinuationCommit),
    `${directContinuationCommitRel}: continuation commit must require success receipt`,
  );
}

function rustFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...rustFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.rs')) files.push(path.relative(repoRoot, absolute));
  }
  return files;
}

function validateRuntimeIsolationSource() {
  for (const rel of [directKernelRel, directCoreRel]) {
    const source = readText(rel);
    requireValue(!source.includes('responses:deepseek-console-go') && !source.includes('responses:thinking-tags'), `${rel}: execution skeleton must not inspect compatibility profile strings`);
  }

  const healthState = readText(providerHealthStateRel);
  const healthPersistence = readText(providerHealthPersistenceRel);
  const persistenceProjection = healthPersistence.slice(
    healthPersistence.indexOf('pub(super) fn persist_cooldown_state'),
    healthPersistence.indexOf('impl V3ProviderHealthStore'),
  );
  requireValue(healthPersistence.includes('mpsc::sync_channel(V3_PROVIDER_HEALTH_PERSISTENCE_QUEUE_CAPACITY)'), `${providerHealthPersistenceRel}: bounded single persistence writer missing`);
  requireValue(healthPersistence.includes('struct V3ProviderHealthPersistenceTicket'), `${providerHealthPersistenceRel}: immutable health persistence ticket missing`);
  requireValue(persistenceProjection.includes("state: RwLockWriteGuard<'_, V3ProviderHealthState>"), `${providerHealthPersistenceRel}: health persistence owner must consume the write guard`);
  const healthGuardDrop = persistenceProjection.indexOf('drop(state);');
  const healthTicketEnqueue = persistenceProjection.indexOf('ticket.enqueue();');
  requireValue(healthGuardDrop >= 0 && healthTicketEnqueue > healthGuardDrop, `${providerHealthPersistenceRel}: health persistence must enqueue after releasing the write guard`);
  requireValue(!persistenceProjection.includes('replace_entries(') && !persistenceProjection.includes('fs::'), `${providerHealthPersistenceRel}: health persistence projection performs synchronous disk IO`);
  requireValue(!healthState.includes('struct V3ProviderHealthPersistenceWriter'), `${providerHealthStateRel}: health state module must not own the persistence writer implementation`);
  requireValue(!healthState.includes('persist_cooldown_state(&mut state)'), `${providerHealthStateRel}: health mutation must transfer write-guard ownership before persistence enqueue`);

  const responsesRelayRuntime = readText(responsesRelayRuntimeRel);
  const responsesRelayRuntimeInner = readText(responsesRelayRuntimeInnerRel);
  const responsesRelayTypes = readText(responsesRelayTypesRel);
  const responsesRelayFailures = readText(responsesRelayFailuresRel);
  const responsesRelayDryRun = readText(responsesRelayDryRunRel);
  const responsesProjectorStart = responsesRelayRuntime.indexOf('fn project_v3_responses_relay_client_body(');
  const responsesProjectorEnd = responsesRelayRuntime.indexOf('fn v3_responses_relay_now_epoch_ms(', responsesProjectorStart);
  const responsesProjector = responsesRelayRuntime.slice(responsesProjectorStart, responsesProjectorEnd);
  requireValue(responsesProjector.includes('attempt_budget: crate::nodes::V3AttemptBudget'), `${responsesRelayRuntimeRel}: Responses client projection must receive the request attempt budget`);
  requireValue(responsesProjector.includes('build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05_with_budget(') && !responsesProjector.includes('V3AttemptBudget::process_default()'), `${responsesRelayRuntimeRel}: Responses production client projection must use the caller request budget`);
  requireValue(responsesProjector.includes('.map_err(V3ResponsesRelayRuntimeError::ExecutionControlResponse)?') && !responsesProjector.includes('.map_err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec)?'), `${responsesRelayRuntimeRel}: Responses local replay failure must use response execution-control attribution`);
  requireValue(responsesRelayTypes.includes('ExecutionControlResponse(String)'), `${responsesRelayTypesRel}: Responses response execution-control variant missing`);
  const providerFailureClassifierStart = responsesRelayFailures.indexOf('pub(crate) fn is_v3_responses_provider_response_failure(');
  const providerFailureClassifierEnd = responsesRelayFailures.indexOf('pub(crate) fn provider_response_hook_failure(', providerFailureClassifierStart);
  requireValue(!responsesRelayFailures.slice(providerFailureClassifierStart, providerFailureClassifierEnd).includes('ExecutionControlResponse'), `${responsesRelayFailuresRel}: Responses local replay failure enters provider response classification`);
  requireValue(responsesRelayDryRun.includes('V3ResponsesRelayRuntimeError::ExecutionControlResponse(message)') && responsesRelayDryRun.includes('"V3ServerRespOutbound06ClientFrame"') && responsesRelayDryRun.includes('"responses_relay_response_execution_control_error"') && responsesRelayDryRun.includes('error_output(source, 599,'), `${responsesRelayDryRunRel}: Responses local replay failure must project response-stage 599`);
  const responsesBuilderStart = responsesRelayRuntime.indexOf('pub(crate) fn build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05_with_budget(');
  const responsesBuilderEnd = responsesRelayRuntime.indexOf('fn append_v3_responses_client_reasoning_progress_frames(', responsesBuilderStart);
  const responsesBuilder = responsesRelayRuntime.slice(responsesBuilderStart, responsesBuilderEnd);
  requireValue(responsesBuilder.includes('V3CommittedClientSseBuilder::with_budget(attempt_budget)') && !responsesBuilder.includes('V3AttemptBudget::process_default()'), `${responsesRelayRuntimeRel}: Responses sealed replay builder must consume the supplied request budget`);
  const responsesProductionProjectionCalls = responsesRelayRuntimeInner.match(/project_v3_responses_relay_client_body\([\s\S]{0,420}attempt_budget\.clone\(\)/gu) ?? [];
  requireValue(responsesProductionProjectionCalls.length >= 2, `${responsesRelayRuntimeInnerRel}: every Responses production projection must reuse the request attempt budget`);

  const anthropicRelayRuntime = readText(anthropicRelayRuntimeRel);
  const anthropicRelayRuntimeHelpers = readText(anthropicRelayRuntimeHelpersRel);
  const anthropicRelayRuntimeSurface = `${anthropicRelayRuntime}\n${anthropicRelayRuntimeHelpers}`;
  const anthropicInnerStart = anthropicRelayRuntime.indexOf('async fn execute_v3_anthropic_relay_runtime_inner');
  const anthropicInnerEnd = anthropicRelayRuntime.indexOf('fn anthropic_relay_client_headers_as_provider_request_headers(', anthropicInnerStart);
  const anthropicInner = anthropicRelayRuntime.slice(anthropicInnerStart, anthropicInnerEnd);
  requireValue(anthropicInner.includes('V3RequestExecutionControl::from_manifest(manifest, &input.server_id)') && anthropicInner.includes('let attempt_budget = request_execution_control.attempt_budget();'), `${anthropicRelayRuntimeRel}: Anthropic Relay must create one request execution control`);
  const anthropicAttemptAdmission = anthropicInner.search(/attempt_budget\s*\.\s*admit_transport_attempt\(\)/u);
  const anthropicTransportSend = anthropicInner.indexOf('transport.send(transport_request)');
  requireValue(anthropicAttemptAdmission >= 0 && anthropicAttemptAdmission < anthropicTransportSend, `${anthropicRelayRuntimeRel}: Anthropic provider send must consume the request transport-attempt budget before network I/O`);
  const anthropicSuccessProjectionCalls = anthropicInner.match(/project_v3_anthropic_client_sse_stream_with_budget\([\s\S]{0,220}attempt_budget\.clone\(\)/gu) ?? [];
  requireValue(anthropicSuccessProjectionCalls.length >= 2 && !anthropicInner.includes('V3AttemptBudget::process_default()'), `${anthropicRelayRuntimeRel}: every Anthropic success branch must seal client SSE with the request budget`);
  requireValue(anthropicRelayRuntimeSurface.includes('pub enum V3AnthropicRelayClientBody') && anthropicRelayRuntimeSurface.includes('pub client_body: V3AnthropicRelayClientBody'), `${anthropicRelayRuntimeHelpersRel}: Anthropic Runtime output must carry a typed non-optional client body`);
  requireValue(anthropicRelayRuntimeSurface.includes('pub fn into_v3_resp_15_client_payload(self)') && !anthropicRelayRuntimeSurface.includes('pub client_sse_stream: Option<'), `${anthropicRelayRuntimeHelpersRel}: Anthropic Runtime output must make sealed replay body validity unrepresentable`);
  requireValue(!anthropicRelayRuntimeSurface.includes('project_v3_anthropic_client_sse_stream_from_manifest'), `${anthropicRelayRuntimeHelpersRel}: manifest-derived Anthropic replay budget must be physically removed`);

  const serverExecutors = readText(serverExecutorsRel);
  const serverAnthropicOutput = serverExecutors.slice(serverExecutors.indexOf('pub(crate) fn anthropic_relay_output_response('));
  requireValue(serverAnthropicOutput.includes('output.into_v3_resp_15_client_payload()') && serverAnthropicOutput.includes('match frame.body'), `${serverExecutorsRel}: Server must exhaustively consume the Runtime-sealed Anthropic client body`);
  requireValue(!serverAnthropicOutput.includes('client_sse_stream') && !serverAnthropicOutput.includes('successful Anthropic Runtime SSE output must carry'), `${serverExecutorsRel}: Server must not unwrap or expect an optional Anthropic replay stream`);
  requireValue(!serverExecutors.includes('project_v3_anthropic_client_sse_stream_from_manifest') && !serverExecutors.includes('V3AttemptBudget::from_manifest'), `${serverExecutorsRel}: Server must not reconstruct execution budget or client replay`);

  const attemptStorePolicy = readText(configAttemptStoreRel);
  const configTypes = readText(configTypesRel);
  const configValidate = readText(configValidateRel);
  requireValue(attemptStorePolicy.includes('pub struct V3AttemptStorePolicyAuthoringConfig'), `${configAttemptStoreRel}: attempt-store authoring policy owner missing`);
  requireValue(attemptStorePolicy.includes('pub struct V3AttemptStorePolicyManifest'), `${configAttemptStoreRel}: attempt-store manifest policy owner missing`);
  requireValue(attemptStorePolicy.includes('pub(crate) fn compile_attempt_store_policy('), `${configAttemptStoreRel}: attempt-store policy compiler missing`);
  requireValue(configValidate.includes('compile_attempt_store_policy(server_id, authoring.attempt_store)?'), `${configValidateRel}: config validation must consume the attempt-store policy compiler`);
  requireValue(!configTypes.includes('pub struct V3AttemptStorePolicyAuthoringConfig') && !configTypes.includes('pub struct V3AttemptStorePolicyManifest'), `${configTypesRel}: aggregate config types must not own attempt-store policy implementations`);

  const webui = readText(webuiObservabilityRel);
  const observabilityStore = readText(observabilityStoreRel);
  const configLib = readText(configLibRel);
  const recordStart = webui.indexOf('pub(crate) fn record_observed(');
  const appendStart = webui.indexOf('pub(crate) fn append_persisted_row(', recordStart);
  const recordObserved = webui.slice(recordStart, appendStart);
  requireValue(webui.includes('mpsc::sync_channel(V3_WEBUI_PERSISTENCE_QUEUE_CAPACITY)'), `${webuiObservabilityRel}: bounded single observability writer missing`);
  requireValue(webui.includes('v3_webui_observability_read_rows_bounded(') && webui.includes('V3_WEBUI_RECENT_REQUEST_CAPACITY'), `${webuiObservabilityRel}: bounded startup load missing`);
  requireValue(recordObserved.indexOf('drop(inner);') >= 0 && recordObserved.indexOf('drop(inner);') < recordObserved.indexOf('writer.enqueue(row);'), `${webuiObservabilityRel}: observability persistence must enqueue after releasing request mutex`);
  requireValue(!recordObserved.includes('append_persisted_row(') && !recordObserved.includes('v3_webui_observability_append_row('), `${webuiObservabilityRel}: request hot path performs synchronous observability disk IO`);
  requireValue(observabilityStore.includes('pub fn v3_webui_observability_append_row(') && observabilityStore.includes('pub fn v3_webui_observability_read_rows_bounded('), `${observabilityStoreRel}: observability storage owner is incomplete`);
  requireValue(!configLib.includes('v3_webui_observability_append_row') && !configLib.includes('v3_webui_observability_read_rows'), `${configLibRel}: Config must not export runtime observability IO`);

  const server = readText(serverLibRel);
  const prepareStart = server.indexOf('pub async fn prepare_for_exec');
  const prepareEnd = server.indexOf('pub fn restore_front_checkpoints', prepareStart);
  requireValue(server.slice(prepareStart, prepareEnd).includes('self.flush_runtime_persistence();'), `${serverLibRel}: exec shutdown must await persistence flush receipts`);
}

function renderMarkdown() {
  const lines = [
    '<!-- AUTO-GENERATED: edit the manifest/maps, then run `npm run render:v3-execution-control-payload-architecture`. -->',
    '# V3 Execution Control / Payload Architecture',
    '',
    `Status: \`${manifest.status}\``,
    '',
    manifest.summary,
    '',
    '## Canonical Sources',
    '',
    ...Object.entries(manifest.canonical_docs).map(([name, rel]) => `- ${name}: \`${rel}\``),
    `- manifest: \`${manifestRel}\``,
    `- resource map: \`${resourceMapRel}\``,
    `- function map: \`${functionMapRel}\``,
    `- call map: \`${callMapRel}\``,
    `- module registry: \`${moduleRegistryRel}\``,
    `- verification map: \`${verificationMapRel}\``,
    ...Object.entries(manifest.implementation_owner_files).map(([name, rel]) => `- implementation owner ${name}: \`${rel}\``),
    '',
    '## Lifecycle',
    '',
    '```mermaid',
    'flowchart LR',
    ...array(manifest.edges).map((edge) => `  ${safeId(edge.from_node)}["${edge.from_node}"] -->|${edge.step_id}| ${safeId(edge.to_node)}["${edge.to_node}"]`),
    '```',
    '',
    '## Control, Payload, Diagnostics, Persistence',
    '',
    '| lane | resources | execution authority |',
    '| --- | --- | --- |',
    `| control | ${codeList(manifest.control_resources)} | request lifecycle only |`,
    `| payload | ${codeList(manifest.payload_resources)} | none; bounded storage only |`,
    `| diagnostics | ${codeList(manifest.diagnostic_resources)} | none |`,
    `| persistence | ${codeList(manifest.persistence_resources)} | none; ordered bounded writers |`,
    '',
    '## Budget Contract',
    '',
    `- Per attempt: \`${manifest.budget_contract.per_attempt}\``,
    `- Per request: \`${manifest.budget_contract.per_request}\``,
    `- Process global: \`${manifest.budget_contract.process_global}\``,
    `- Residence/deadline: \`${manifest.budget_contract.residence_or_deadline}\``,
    `- Reserve before append/copy: \`${manifest.budget_contract.reserve_before_append_or_copy}\``,
    `- Initial storage: \`${manifest.budget_contract.initial_storage}\``,
    `- Disk spill: \`${manifest.budget_contract.disk_spill}\``,
    '',
    '## Success and Failure Truth',
    '',
    `- Success issuer: \`${manifest.success_receipt_contract.issuer}\``,
    `- Success consumers: ${codeList(manifest.success_receipt_contract.consumers)}`,
    `- Forbidden success evidence: ${codeList(manifest.success_receipt_contract.forbidden_evidence)}`,
    `- Failure kinds: ${codeList(manifest.failure_kinds)}`,
    `- Responses client replay local failure: \`${manifest.failure_attribution_contract.responses_client_replay.runtime_variant}\` → \`${manifest.failure_attribution_contract.responses_client_replay.client_status}\` / \`${manifest.failure_attribution_contract.responses_client_replay.client_code}\`; provider classification \`${manifest.failure_attribution_contract.responses_client_replay.provider_response_classification}\``,
    '',
    '## Current Runtime-Red Bindings',
    '',
    '| issue | current symbols |',
    '| --- | --- |',
    ...array(manifest.current_runtime_red_bindings).map((row) => `| \`${row.id}\` | ${codeList(row.symbols)} |`),
    '',
    '## Module Responsibilities',
    '',
  ];
  for (const [name, contract] of Object.entries(manifest.module_contracts)) {
    lines.push(`### ${name}`, '', `Owns: ${codeList(contract.owns)}`, '', `Forbids: ${codeList(contract.forbids)}`, '');
  }
  lines.push(
    '## Completion Gate',
    '',
    ...Object.entries(manifest.completion_contract).map(([key, value]) => `- \`${key}\`: \`${value}\``),
    '',
    '## Verification',
    '',
    ...array(manifest.verification_gates).map((gate) => `- \`${gate}\``),
  );
  return `${lines.join('\n')}\n`;
}

function renderHtml() {
  const nodeCards = array(manifest.node_ids)
    .map((node) => `<li><code>${escapeHtml(node)}</code></li>`)
    .join('');
  const issueRows = array(manifest.current_runtime_red_bindings)
    .map((row) => `<tr><td><code>${escapeHtml(row.id)}</code></td><td>${array(row.symbols).map((value) => `<code>${escapeHtml(value)}</code>`).join('<br>')}</td></tr>`)
    .join('');
  const moduleSections = Object.entries(manifest.module_contracts)
    .map(([name, contract]) => `<section><h2>${escapeHtml(name)}</h2><h3>Owns</h3>${htmlList(contract.owns)}<h3>Forbids</h3>${htmlList(contract.forbids)}</section>`)
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>V3 Execution Control / Payload Architecture</title>
<style>body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;max-width:1120px;margin:0 auto;padding:32px;color:#172033;background:#f7f8fa}main{background:white;border:1px solid #dde2ea;border-radius:16px;padding:32px;box-shadow:0 8px 30px #1d2b4412}h1{font-size:2rem}h2{margin-top:2rem;border-bottom:1px solid #e5e9ef;padding-bottom:.4rem}code{background:#f0f3f7;border-radius:4px;padding:.12rem .3rem}table{border-collapse:collapse;width:100%}th,td{border:1px solid #dfe4eb;padding:.65rem;text-align:left;vertical-align:top}.status{display:inline-block;background:#fff1db;color:#7a4700;border-radius:999px;padding:.35rem .7rem}.flow{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:.6rem;padding:0;list-style:none}.flow li{border-left:4px solid #5b6ee1;background:#f5f6ff;padding:.7rem}</style></head>
<body><main><h1>V3 Execution Control / Payload Architecture</h1><p class="status">${escapeHtml(manifest.status)}</p><p>${escapeHtml(manifest.summary)}</p>
<h2>Lifecycle nodes</h2><ol class="flow">${nodeCards}</ol>
<h2>Current runtime-red bindings</h2><table><thead><tr><th>Issue</th><th>Current source symbols</th></tr></thead><tbody>${issueRows}</tbody></table>
${moduleSections}
<h2>Completion contract</h2>${htmlList(Object.entries(manifest.completion_contract).map(([key, value]) => `${key}: ${value}`))}
<h2>Verification gates</h2>${htmlList(manifest.verification_gates)}
<p>Generated from <code>${escapeHtml(manifestRel)}</code>. Do not edit this page by hand.</p></main></body></html>\n`;
}

function writeOrCompare(rel, expected) {
  const target = path.join(repoRoot, rel);
  if (check) {
    if (!fs.existsSync(target)) failures.push(`${rel}: generated file missing`);
    else if (fs.readFileSync(target, 'utf8') !== expected) failures.push(`${rel}: generated file stale`);
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, expected, 'utf8');
}

function safeId(value) { return String(value).replace(/[^A-Za-z0-9_]/g, '_'); }
function codeList(values) { return array(values).map((value) => `\`${value}\``).join(', '); }
function htmlList(values) { return `<ul>${array(values).map((value) => `<li><code>${escapeHtml(value)}</code></li>`).join('')}</ul>`; }
function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
