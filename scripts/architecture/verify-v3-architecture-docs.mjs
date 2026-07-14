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

for (const file of requiredFiles) if (!fs.existsSync(abs(file))) fail(`${file}: missing`);

const combinedDocs = requiredFiles.map(read).join('\n');
for (const phrase of [
  'V3ConfigStore', 'TargetPoolExhausted', 'Static hook', 'config.v3.toml',
  'Provider owns', 'Dry run', 'P1 — Full Config compiler',
]) if (!combinedDocs.includes(phrase)) fail(`V3 docs: missing contract phrase ${phrase}`);
for (const token of ['big_skeleton', 'small_skeleton']) {
  if (combinedDocs.includes(token)) fail(`V3 docs: forbidden naming token ${token}`);
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
  }
}

const reviewSurface = read('docs/architecture/wiki/v3-responses-direct-mainline.md')
  + read('docs/design/v3-routecodex-runtime-resource-contract.md');
for (const node of requiredNodes) if (!reviewSurface.includes(node)) fail(`review surface: missing node ${node}`);

for (const featureId of ['v3.responses_direct_mvp_architecture', 'v3.debug_error_foundation']) {
  const feature = array(verificationMap.features).find((entry) => entry.feature_id === featureId);
  if (!feature) fail(`verification map: missing ${featureId}`);
  for (const gate of array(feature?.required_gates)) {
    if (!String(gate).startsWith('npm run ')) fail(`verification map: invalid gate ${gate}`);
  }
}

if (failures.length) {
  console.error('[verify:v3-architecture-docs] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-architecture-docs] ok');
console.log(`- docs: ${requiredFiles.length}`);
console.log(`- resources: ${resourceIds.size}`);
console.log(`- edges: ${allEdges.length}`);
