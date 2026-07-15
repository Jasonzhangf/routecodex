import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const failures = [];
const requiredFiles = [
  'docs/design/v3-system-definition.md',
  'docs/design/v3-routecodex-rust-module-boundaries.md',
  'docs/design/v3-routecodex-runtime-resource-contract.md',
  'docs/design/v3-hub-pipeline-static-skeleton-contract.md',
  'docs/design/v3-hub-relay-fixed-pipeline-contract.md',
  'docs/design/v3-existing-hub-provider-path-audit.md',
  'docs/goals/v3-foundation-implementation-order.md',
  'docs/goals/v3-debug-error-foundation-plan.md',
  'docs/goals/v3-responses-direct-mvp-test-design.md',
  'docs/goals/v3-responses-direct-mvp-implementation-plan.md',
  'docs/goals/v3-hub-pipeline-static-skeleton-implementation-plan.md',
  'docs/goals/v3-hub-relay-four-worker-implementation-plan.md',
  'docs/goals/v3-hub-h2-p6-responses-direct-characterization.md',
  'docs/goals/v3-config-server-full-function-plan.md',
  'docs/goals/v3-virtual-router-full-function-plan.md',
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'docs/architecture/wiki/v3-responses-direct-mainline.md',
  'docs/architecture/wiki/v3-hub-pipeline-static-skeleton.md',
  'docs/architecture/wiki/v3-hub-relay-fixed-pipeline.md',
  'docs/architecture/wiki/v3-config-server-full-function.md',
  'docs/architecture/wiki/v3-config-server-full-function.html',
];
const requiredNodes = [
  'V3Config01FileSource', 'V3Config02AuthoringParsed', 'V3Config03SchemaValidated',
  'V3Config04ResourceRegistryBuilt', 'V3Config05ManifestPublished',
  'V3Server03HttpRequestRaw', 'V3Req04StandardizedResponses',
  'V3Router05RequestClassified', 'V3Router06RoutePoolResolved',
  'V3Router07OpaqueTargetHitOnce', 'V3Target08KindClassified',
  'V3Target09CandidateSetExpanded', 'V3Target10ConcreteProviderSelected',
  'V3ResponsesDirect11Policy', 'V3Provider12ResponsesWirePayload',
  'V3Transport13ResponsesHttpRequest', 'V3ProviderResp14Raw',
  'V3Resp15ClientPayload', 'V3Server16HttpFrame',
  'V3DebugTraceContextStarted', 'V3DebugEventLedgerRecorded',
  'V3DebugRawCaptureStored', 'V3DebugSnapshotSessionRegistered',
  'V3DryRunNoNetworkTerminalEffect',
  'V3Error01SourceRaised', 'V3Error02Classified',
  'V3Error03TargetLocalAction', 'V3Error04TargetExhaustionDecision',
  'V3Error05ExecutionDecision', 'V3Error06ClientProjected',
  'V3ProviderHealthStateMutated', 'V3ProviderAvailabilityProjected',
  'V3RouterRequestFacts',
];

const fail = (message) => failures.push(message);
const abs = (file) => path.join(root, file);
const read = (file) => {
  try { return fs.readFileSync(abs(file), 'utf8'); }
  catch (error) { fail(`${file}: cannot read: ${error.message}`); return ''; }
};
const readSourceWithSiblingModule = (file) => {
  const primary = read(file);
  const stem = file.replace(/\.rs$/, '');
  if (!fs.existsSync(abs(stem)) || !fs.statSync(abs(stem)).isDirectory()) return primary;
  const parts = [primary];
  for (const entry of fs.readdirSync(abs(stem))) {
    if (entry.endsWith('.rs')) parts.push(read(path.join(stem, entry)));
  }
  return parts.join('\n');
};
const yaml = (file) => {
  try { return YAML.parse(read(file)); }
  catch (error) { fail(`${file}: YAML parse failed: ${error.message}`); return {}; }
};
const array = (value) => Array.isArray(value) ? value : [];
const p6AnchoredStepIds = new Set([
  'v3-rd-09', 'v3-rd-10', 'v3-rd-11', 'v3-rd-12', 'v3-rd-13', 'v3-rd-14',
]);
const p6AnchoredResourceIds = new Set([
  'v3.responses_direct.policy',
  'v3.response.client_payload',
  'v3.provider.responses_wire_payload',
  'v3.provider.transport_request',
  'v3.response.provider_raw',
]);
const hubV1AnchoredResourceIds = new Set([
  'v3.config.hub_pipeline_declarations',
  'v3.hub.static_hook_registry',
]);
const hubV1PendingResourceIds = new Set([
  'v3.hub.entry_protocol',
  'v3.hub.continuation_ownership',
  'v3.hub.execution_plan',
  'v3.hub.resolved_target',
  'v3.hub.provider_protocol',
  'v3.request.provider_semantic',
  'v3.hub.provider_wire_payload',
  'v3.hub.response_semantic',
  'v3.continuation.remote_binding',
  'v3.continuation.local_context_truth',
]);
const hubV1AnchoredStepIds = new Set([
  'v3-hub-req-01', 'v3-hub-req-02', 'v3-hub-req-03', 'v3-hub-req-04',
  'v3-hub-req-05', 'v3-hub-req-06', 'v3-hub-req-07', 'v3-hub-req-08',
  'v3-hub-resp-01', 'v3-hub-resp-02', 'v3-hub-resp-03', 'v3-hub-resp-04',
  'v3-hub-resp-05',
]);
const hubV1EdgePairs = new Map([
  ['v3-hub-req-01', ['V3HubReqInbound01ClientRaw', 'V3HubReqInbound02Normalized']],
  ['v3-hub-req-02', ['V3HubReqInbound02Normalized', 'V3HubReqContinuation03Classified']],
  ['v3-hub-req-03', ['V3HubReqContinuation03Classified', 'V3HubReqChatProcess04Governed']],
  ['v3-hub-req-04', ['V3HubReqChatProcess04Governed', 'V3HubReqExecution05Planned']],
  ['v3-hub-req-05', ['V3HubReqExecution05Planned', 'V3HubReqTarget06Resolved']],
  ['v3-hub-req-06', ['V3HubReqTarget06Resolved', 'V3HubReqOutbound07ProviderSemantic']],
  ['v3-hub-req-07', ['V3HubReqOutbound07ProviderSemantic', 'V3ProviderReqOutbound08WirePayload']],
  ['v3-hub-req-08', ['V3ProviderReqOutbound08WirePayload', 'V3ProviderReqOutbound09TransportRequest']],
  ['v3-hub-resp-01', ['V3ProviderRespInbound01Raw', 'V3HubRespInbound02Normalized']],
  ['v3-hub-resp-02', ['V3HubRespInbound02Normalized', 'V3HubRespChatProcess03Governed']],
  ['v3-hub-resp-03', ['V3HubRespChatProcess03Governed', 'V3HubRespContinuation04Committed']],
  ['v3-hub-resp-04', ['V3HubRespContinuation04Committed', 'V3HubRespOutbound05ClientSemantic']],
  ['v3-hub-resp-05', ['V3HubRespOutbound05ClientSemantic', 'V3ServerRespOutbound06ClientFrame']],
]);

for (const file of requiredFiles) if (!fs.existsSync(abs(file))) fail(`${file}: missing`);

const combinedDocs = requiredFiles.map(read).join('\n');
for (const phrase of [
  'V3ConfigStore', 'TargetPoolExhausted', 'Static hook', 'config.v3.toml',
  'Provider owns', 'Dry run', 'P1 — Full Config compiler',
  'v3.virtual_router_full_function', 'v3.route.selection_plan',
]) if (!combinedDocs.includes(phrase)) fail(`V3 docs: missing contract phrase ${phrase}`);
for (const token of ['big_skeleton', 'small_skeleton']) {
  if (combinedDocs.includes(token)) fail(`V3 docs: forbidden naming token ${token}`);
}
const p6ContractDocs = [
  'docs/goals/v3-responses-direct-mvp-implementation-plan.md',
  'docs/goals/v3-responses-direct-mvp-test-design.md',
  'docs/design/v3-system-definition.md',
  'docs/design/v3-routecodex-runtime-resource-contract.md',
  'docs/architecture/wiki/v3-responses-direct-mainline.md',
].map(read).join('\n');
for (const phrase of [
  'P0-P5',
  'binding_pending',
  'generic',
  'routecodex-v3-provider-responses',
  'controlled-upstream',
  'Runtime kernel is the only full lifecycle executor',
]) if (!p6ContractDocs.includes(phrase)) fail(`P6 contract docs: missing calibration phrase ${phrase}`);
if (/\b(?:cc|asxs)\b/.test(p6ContractDocs)) {
  fail('P6 contract docs: deployment provider identity leaked into generic Provider contract');
}
const hubV1ContractDocs = [
  'docs/design/v3-hub-pipeline-static-skeleton-contract.md',
  'docs/goals/v3-hub-pipeline-static-skeleton-implementation-plan.md',
  'docs/architecture/wiki/v3-hub-pipeline-static-skeleton.md',
].map(read).join('\n');
const hubV1CanonicalContract = read('docs/design/v3-hub-pipeline-static-skeleton-contract.md');
const hubV1ExistingPathAudit = read('docs/design/v3-existing-hub-provider-path-audit.md');
for (const phrase of [
  'V3HubReqContinuation03Classified',
  'V3HubReqChatProcess04Governed',
  'V3HubReqExecution05Planned',
  'V3HubReqTarget06Resolved',
  'V3HubRespChatProcess03Governed',
  'V3HubRespContinuation04Committed',
  'restore(normalize(save(context))) == context',
  'Static hook slots',
  'Provider wire protocol',
  'servertool followup re-entry',
  'same kernel and replaces only the transport',
  'JSON or SSE',
  'global Error chain',
  'Physically delete',
  'binding_pending',
]) if (!hubV1CanonicalContract.includes(phrase)) fail(`Hub v1 contract docs: missing invariant ${phrase}`);
for (const phrase of [
  'HubPipelineEngine::execute',
  'router-direct-pipeline.ts',
  'provider-direct-pipeline.ts',
  'RequestExecutor',
  'Branch-to-hook migration matrix',
  'same wire protocol does not imply Direct',
]) if (!hubV1ExistingPathAudit.includes(phrase)) fail(`Hub v1 existing-path audit: missing evidence ${phrase}`);
for (const forbidden of [
  /provider_family\s*==/,
  /same protocol\s*=\s*Direct/i,
]) if (forbidden.test(hubV1ContractDocs)) fail(`Hub v1 contract docs: forbidden design ${forbidden}`);

const hubRelayContract = read('docs/design/v3-hub-relay-fixed-pipeline-contract.md');
const hubRelayContractDocs = [
  hubRelayContract,
  read('docs/goals/v3-hub-relay-four-worker-implementation-plan.md'),
  read('docs/architecture/wiki/v3-hub-relay-fixed-pipeline.md'),
].join('\n');
for (const phrase of [
  'feature_id:v3.hub_relay_request_semantics',
  'feature_id:v3.hub_relay_response_semantics',
  'feature_id:v3.hub_relay_runtime_resources_hooks',
  'feature_id:v3.hub_relay_gate_review_surface',
  'V3HubReqChatProcess04Governed',
  'V3HubRespChatProcess03Governed',
  'restore(normalize(save(context))) == context',
  'Between save and restore',
  'semantic-equivalent normalization',
  'Servertool is a Chat Process hook profile',
  'Runtime consumes only Manifest resources',
  'Live Relay remains pending',
]) if (!hubRelayContractDocs.includes(phrase)) fail(`Relay contract docs: missing invariant ${phrase}`);
for (const phrase of [
  'feature_id:v3.hub_relay_request_semantics',
  'semantic-equivalent normalization',
]) if (!hubRelayContract.includes(phrase)) fail(`Relay contract docs: missing invariant ${phrase}`);
if (!hubRelayContractDocs.includes('Do not create a second lifecycle')) {
  fail('Relay contract docs: missing second lifecycle ban');
}
if (!hubRelayContractDocs.includes('dynamic hook discovery')) {
  fail('Relay contract docs: missing dynamic hook discovery ban');
}

for (const file of requiredFiles.filter((entry) => entry.endsWith('.md'))) {
  const text = read(file);
  const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
  let match;
  while ((match = linkPattern.exec(text)) !== null) {
    const target = match[1].split('#')[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    if (!fs.existsSync(path.resolve(path.dirname(abs(file)), target))) fail(`${file}: broken link ${match[1]}`);
  }
}

const resourceMap = yaml('docs/architecture/v3-resource-operation-map.yml');
const functionMap = yaml('docs/architecture/v3-function-map.yml');
const mainlineMap = yaml('docs/architecture/v3-mainline-call-map.yml');
const verificationMap = yaml('docs/architecture/v3-verification-map.yml');
const packageJson = JSON.parse(read('package.json'));
if (resourceMap.version !== 2) fail('v3-resource-operation-map.yml: version must be 2');
if (functionMap.version !== 1) fail('v3-function-map.yml: version must be 1');
if (mainlineMap.version !== 2) fail('v3-mainline-call-map.yml: version must be 2');
if (verificationMap.version !== 2) fail('v3-verification-map.yml: version must be 2');

const relayWorkerFeatureIds = [
  'v3.hub_relay_request_semantics',
  'v3.hub_relay_response_semantics',
  'v3.hub_relay_runtime_resources_hooks',
  'v3.hub_relay_gate_review_surface',
];
const forbiddenFractionalNodeId = /\bV3[A-Za-z]*03(?:a|_1|\.5)[A-Za-z]*\b/;
for (const file of [
  'docs/design/v3-hub-relay-fixed-pipeline-contract.md',
  'docs/goals/v3-hub-relay-four-worker-implementation-plan.md',
  'docs/architecture/wiki/v3-hub-relay-fixed-pipeline.md',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
]) {
  if (forbiddenFractionalNodeId.test(read(file))) fail(`${file}: fractional/reused Hub node ID is forbidden`);
}
const hubRelayContractDocsLower = hubRelayContractDocs.toLowerCase();
for (const phrase of [
  'unbounded deep copy',
  'full SSE materialize',
  'debug/snapshot copy',
]) if (!hubRelayContractDocsLower.includes(phrase.toLowerCase())) fail(`Relay contract docs: missing payload copy-budget invariant ${phrase}`);

const resourceIds = new Set();
for (const [index, resource] of array(resourceMap.resources).entries()) {
  const where = `resource[${index}]`;
  if (!resource?.resource_id?.startsWith('v3.')) fail(`${where}: invalid resource_id`);
  if (resourceIds.has(resource.resource_id)) fail(`${where}: duplicate ${resource.resource_id}`);
  resourceIds.add(resource.resource_id);
  for (const field of ['resource_kind', 'lifecycle', 'owner_crate', 'owner_node', 'binding_status']) {
    if (typeof resource[field] !== 'string' || !resource[field]) fail(`${where}: missing ${field}`);
  }
  for (const field of ['identity', 'allowed_writers', 'allowed_readers', 'forbidden_writers']) {
    if (!Array.isArray(resource[field]) || resource[field].length === 0) fail(`${where}: missing ${field}`);
  }
  if (p6AnchoredResourceIds.has(resource.resource_id) && resource.binding_status !== 'anchored') {
    fail(`${where}: P6 resource must be anchored after source binding`);
  }
  if (hubV1PendingResourceIds.has(resource.resource_id) && resource.binding_status !== 'binding_pending') {
    fail(`${where}: unimplemented Hub v1 business resource must remain binding_pending`);
  }
  if (hubV1AnchoredResourceIds.has(resource.resource_id) && resource.binding_status !== 'anchored') {
    fail(`${where}: implemented Hub v1 H1 resource must be anchored`);
  }
  if (!['normal_payload', 'provider_wire', 'transport'].includes(resource.resource_kind)
      && resource.may_enter_provider_body !== false) fail(`${where}: control resource may enter provider body`);
  if (resource.resource_id !== 'v3.response.client_payload' && resource.may_enter_client_body === true) {
    fail(`${where}: unexpected client body permission`);
  }
}

const chains = array(mainlineMap.chains);
for (const chainId of [
  'v3.config.compile',
  'v3.responses_direct.required_mainline',
  'v3.hub_pipeline.v1.request',
  'v3.hub_pipeline.v1.response',
]) {
  if (!chains.some((chain) => chain.chain_id === chainId)) fail(`mainline: missing chain ${chainId}`);
}
const allEdges = chains.flatMap((chain) => array(chain.edges));
for (const stepId of hubV1AnchoredStepIds) {
  const edge = allEdges.find((candidate) => candidate.step_id === stepId);
  if (!edge) fail(`mainline: missing Hub v1 edge ${stepId}`);
  else if (edge.status !== 'anchored' || edge.binding_kind !== 'h1_typed_test') {
    fail(`mainline: ${stepId} must bind the verified H1 typed builder without claiming runtime execution`);
  } else {
    const [fromNode, toNode] = hubV1EdgePairs.get(stepId);
    if (edge.from_node !== fromNode || edge.to_node !== toNode) {
      fail(`mainline: ${stepId} must remain adjacent ${fromNode} -> ${toNode}`);
    }
  }
}

const h1Function = array(functionMap.features).find((entry) => entry.feature_id === 'v3.hub_pipeline_static_skeleton');
if (!h1Function) fail('function map: missing v3.hub_pipeline_static_skeleton');
for (const [field, fileField] of [
  ['entry_symbols', 'owner_file'],
  ['adjacent_builder_symbols', 'owner_file'],
  ['config_symbols', 'config_owner_file'],
]) {
  const file = h1Function?.[fileField];
  if (!file || !fs.existsSync(abs(file))) {
    fail(`function map: missing ${fileField}`);
    continue;
  }
  const sourceWithModules = readSourceWithSiblingModule(file);
  for (const symbol of array(h1Function?.[field])) {
    if (!sourceWithModules.includes(symbol)) fail(`function map: ${symbol} absent from ${file}`);
  }
}
for (const [index, edge] of allEdges.entries()) {
  const where = `edge[${index}]`;
  if (!edge.step_id || !edge.from_node || !edge.to_node || !edge.owner_feature_id) fail(`${where}: incomplete identity`);
  if (!['anchored', 'binding_pending'].includes(edge.status)) fail(`${where}: invalid status ${edge.status}`);
  for (const field of ['consumes', 'produces', 'side_channel_reads', 'side_channel_writes']) {
    for (const resourceId of array(edge.resource_flow?.[field])) {
      if (!resourceIds.has(resourceId)) fail(`${where}: undeclared resource ${resourceId}`);
    }
  }
  if (edge.status === 'anchored') {
    for (const field of ['caller_file', 'callee_file', 'caller_symbol', 'callee_symbol']) {
      if (!edge[field]) fail(`${where}: anchored edge missing ${field}`);
    }
    for (const field of ['caller_file', 'callee_file']) {
      if (edge[field] && !fs.existsSync(abs(edge[field]))) fail(`${where}: missing source ${edge[field]}`);
    }
    for (const [symbolField, fileField] of [['caller_symbol', 'caller_file'], ['callee_symbol', 'callee_file']]) {
      const symbol = String(edge[symbolField] ?? '').split('::').at(-1);
      if (symbol && edge[fileField] && fs.existsSync(abs(edge[fileField])) && !read(edge[fileField]).includes(symbol)) {
        fail(`${where}: ${symbolField} ${edge[symbolField]} absent from ${edge[fileField]}`);
      }
    }
  }
  if (p6AnchoredStepIds.has(edge.step_id)) {
    if (edge.status !== 'anchored') fail(`${where}: ${edge.step_id} must be anchored`);
    if (edge.owner_feature_id !== 'v3.responses_direct_mvp_architecture') {
      if (!['v3.responses_provider_runtime'].includes(edge.owner_feature_id)) {
        fail(`${where}: ${edge.step_id} must use a P6 feature owner`);
      }
    }
  }
}
for (const stepId of p6AnchoredStepIds) {
  if (!allEdges.some((edge) => edge.step_id === stepId)) fail(`mainline: missing P6 edge ${stepId}`);
}

for (const featureId of relayWorkerFeatureIds) {
  const functionFeature = array(functionMap.features).find((entry) => entry.feature_id === featureId);
  const verificationFeature = array(verificationMap.features).find((entry) => entry.feature_id === featureId);
  if (!functionFeature) {
    fail(`Relay worker map: function map missing ${featureId}`);
    continue;
  }
  if (!verificationFeature) fail(`Relay worker map: verification map missing ${featureId}`);
  for (const field of ['resource_bindings', 'mainline_bindings', 'allowed_paths', 'forbidden_paths', 'required_gates']) {
    if (array(functionFeature[field]).length === 0) fail(`Relay worker map: ${featureId} missing ${field}`);
  }
  for (const resourceId of array(functionFeature.resource_bindings)) {
    if (!resourceIds.has(resourceId)) fail(`Relay worker map: ${featureId} binds undeclared resource ${resourceId}`);
  }
  for (const stepId of array(functionFeature.mainline_bindings)) {
    if (!allEdges.some((edge) => edge.step_id === stepId)) {
      fail(`Relay worker map: ${featureId} binds missing mainline step ${stepId}`);
    }
  }
  for (const gate of array(functionFeature.required_gates)) {
    if (!String(gate).startsWith('npm run ')) fail(`Relay worker map: ${featureId} invalid function gate ${gate}`);
    if (verificationFeature && !array(verificationFeature.required_gates).includes(gate)) {
      fail(`Relay worker map: ${featureId} gate missing from verification map: ${gate}`);
    }
    const scriptName = String(gate).slice('npm run '.length).trim();
    if (!packageJson.scripts?.[scriptName]) fail(`Relay worker map: ${featureId} package script missing: ${scriptName}`);
  }
  for (const gate of array(verificationFeature?.required_gates)) {
    if (!array(functionFeature.required_gates).includes(gate)) {
      fail(`Relay worker map: ${featureId} verification gate missing from function map: ${gate}`);
    }
  }
  for (const field of ['owner_scope', 'required_contract', 'required_gates', 'completion_rule']) {
    const value = verificationFeature?.[field];
    if (value == null || (Array.isArray(value) && value.length === 0)) {
      fail(`Relay worker map: verification ${featureId} missing ${field}`);
    }
  }
}

const reviewSurface = read('docs/architecture/wiki/v3-responses-direct-mainline.md')
  + read('docs/design/v3-routecodex-runtime-resource-contract.md');
for (const node of requiredNodes) if (!reviewSurface.includes(node)) fail(`review surface: missing node ${node}`);

for (const featureId of ['v3.hub_pipeline_static_skeleton', 'v3.responses_direct_mvp_architecture', 'v3.responses_provider_runtime', 'v3.debug_error_foundation']) {
  const feature = array(verificationMap.features).find((entry) => entry.feature_id === featureId);
  if (!feature) fail(`verification map: missing ${featureId}`);
  for (const gate of array(feature?.required_gates)) {
    if (!String(gate).startsWith('npm run ')) fail(`verification map: invalid gate ${gate}`);
  }
}
const h1Feature = array(verificationMap.features)
  .find((entry) => entry.feature_id === 'v3.hub_pipeline_static_skeleton');
for (const gate of [
  'npm run verify:v3-p6-freeze',
  'npm run test:v3-p6-freeze-red-fixtures',
  'npm run verify:v3-static-hook-registry',
  'npm run test:v3-h1-source-red-fixtures',
  'npm run test:v3-compile-fail',
  'npm run verify:v3-cargo-fmt',
  'npm run verify:v3-clippy',
  'npm run test:v3-workspace',
]) if (!array(h1Feature?.required_gates).includes(gate)) fail(`verification map: H1 missing required gate ${gate}`);
const h2Feature = array(verificationMap.features)
  .find((entry) => entry.feature_id === 'v3.responses_direct_h2_equivalence_harness');
if (!h2Feature) fail('verification map: missing v3.responses_direct_h2_equivalence_harness');
for (const gate of [
  'npm run verify:v3-h2-equivalence-harness',
  'npm run test:v3-h2-equivalence-red-fixtures',
  'npm run test:v3-h2-p6-controlled-replay',
]) if (!array(h2Feature?.required_gates).includes(gate)) fail('verification map: H2 missing required gate ' + gate);
const p6Feature = array(verificationMap.features)
  .find((entry) => entry.feature_id === 'v3.responses_direct_mvp_architecture');
for (const gate of [
  'npm run verify:v3-architecture-docs',
  'npm run verify:v3-module-boundaries',
  'npm run test:v3-source-gate-red-fixtures',
  'npm run test:v3-compile-fail',
  'npm run test:v3-provider-responses',
  'npm run test:v3-workspace',
]) if (!array(p6Feature?.required_gates).includes(gate)) fail(`verification map: P6 missing required gate ${gate}`);

const providerFeature = array(verificationMap.features)
  .find((entry) => entry.feature_id === 'v3.responses_provider_runtime');
for (const gate of [
  'npm run test:v3-provider-responses',
  'npm run verify:v3-module-boundaries',
  'npm run test:v3-source-gate-red-fixtures',
  'npm run test:v3-compile-fail',
]) if (!array(providerFeature?.required_gates).includes(gate)) fail(`verification map: Provider feature missing required gate ${gate}`);

const configServerFeature = array(verificationMap.features)
  .find((entry) => entry.feature_id === 'v3.config_server_full_function');
if (!configServerFeature) fail('verification map: missing v3.config_server_full_function');
for (const gate of [
  'npm run verify:v3-module-boundaries',
  'npm run test:v3-source-gate-red-fixtures',
  'npm run test:v3-workspace',
  'npm run build:v3-cli',
]) if (!array(configServerFeature?.required_gates).includes(gate)) fail(`verification map: Config/Server missing required gate ${gate}`);

if (failures.length) {
  console.error('[verify:v3-architecture-docs] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-architecture-docs] ok');
console.log(`- docs: ${requiredFiles.length}`);
console.log(`- resources: ${resourceIds.size}`);
console.log(`- edges: ${allEdges.length}`);
