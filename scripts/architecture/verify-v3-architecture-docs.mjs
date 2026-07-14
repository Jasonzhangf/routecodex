import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const failures = [];
const requiredFiles = [
  'docs/design/v3-system-definition.md',
  'docs/design/v3-routecodex-rust-module-boundaries.md',
  'docs/design/v3-routecodex-runtime-resource-contract.md',
  'docs/goals/v3-foundation-implementation-order.md',
  'docs/goals/v3-debug-error-foundation-plan.md',
  'docs/goals/v3-responses-direct-mvp-test-design.md',
  'docs/goals/v3-responses-direct-mvp-implementation-plan.md',
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'docs/architecture/wiki/v3-responses-direct-mainline.md',
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
];

const fail = (message) => failures.push(message);
const abs = (file) => path.join(root, file);
const read = (file) => {
  try { return fs.readFileSync(abs(file), 'utf8'); }
  catch (error) { fail(`${file}: cannot read: ${error.message}`); return ''; }
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

for (const file of requiredFiles) if (!fs.existsSync(abs(file))) fail(`${file}: missing`);

const combinedDocs = requiredFiles.map(read).join('\n');
for (const phrase of [
  'V3ConfigStore', 'TargetPoolExhausted', 'Static hook', 'config.v3.toml',
  'Provider owns', 'Dry run', 'P1 — Full Config compiler',
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
const mainlineMap = yaml('docs/architecture/v3-mainline-call-map.yml');
const verificationMap = yaml('docs/architecture/v3-verification-map.yml');
if (resourceMap.version !== 2) fail('v3-resource-operation-map.yml: version must be 2');
if (mainlineMap.version !== 2) fail('v3-mainline-call-map.yml: version must be 2');
if (verificationMap.version !== 2) fail('v3-verification-map.yml: version must be 2');

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
  if (!['normal_payload', 'provider_wire', 'transport'].includes(resource.resource_kind)
      && resource.may_enter_provider_body !== false) fail(`${where}: control resource may enter provider body`);
  if (resource.resource_id !== 'v3.response.client_payload' && resource.may_enter_client_body === true) {
    fail(`${where}: unexpected client body permission`);
  }
}

const chains = array(mainlineMap.chains);
for (const chainId of ['v3.config.compile', 'v3.responses_direct.required_mainline']) {
  if (!chains.some((chain) => chain.chain_id === chainId)) fail(`mainline: missing chain ${chainId}`);
}
const allEdges = chains.flatMap((chain) => array(chain.edges));
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

const reviewSurface = read('docs/architecture/wiki/v3-responses-direct-mainline.md')
  + read('docs/design/v3-routecodex-runtime-resource-contract.md');
for (const node of requiredNodes) if (!reviewSurface.includes(node)) fail(`review surface: missing node ${node}`);

for (const featureId of ['v3.responses_direct_mvp_architecture', 'v3.responses_provider_runtime', 'v3.debug_error_foundation']) {
  const feature = array(verificationMap.features).find((entry) => entry.feature_id === featureId);
  if (!feature) fail(`verification map: missing ${featureId}`);
  for (const gate of array(feature?.required_gates)) {
    if (!String(gate).startsWith('npm run ')) fail(`verification map: invalid gate ${gate}`);
  }
}
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

if (failures.length) {
  console.error('[verify:v3-architecture-docs] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-architecture-docs] ok');
console.log(`- docs: ${requiredFiles.length}`);
console.log(`- resources: ${resourceIds.size}`);
console.log(`- edges: ${allEdges.length}`);
