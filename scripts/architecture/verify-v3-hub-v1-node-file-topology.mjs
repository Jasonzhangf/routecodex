#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const failures = [];

const ROOT_FILE = 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs';
const TEST_TOPOLOGY_FILE = 'v3/crates/routecodex-v3-runtime/src/hub_v1/tests.rs';
const FUNCTION_MAP = 'docs/architecture/v3-function-map.yml';
const MAINLINE_MAP = 'docs/architecture/v3-mainline-call-map.yml';
const VERIFICATION_MAP = 'docs/architecture/v3-verification-map.yml';
const DESIGN_DOC = 'docs/design/pipeline-type-topology-and-module-boundaries.md';
const VERIFY_SCRIPT = 'scripts/architecture/verify-v3-hub-v1-node-file-topology.mjs';
const RED_SCRIPT = 'scripts/tests/v3-hub-v1-node-file-topology-red-fixtures.mjs';

const REQUIRED_GATES = [
  'npm run verify:v3-hub-v1-node-file-topology',
  'npm run test:v3-hub-v1-node-file-topology-red-fixtures',
];

const NODE_OWNERS = [
  ['V3HubReqInbound01ClientRaw', 'v3/crates/routecodex-v3-runtime/src/hub_v1/req_inbound_01_client_raw.rs', 'build_v3_hub_req_inbound_01_client_raw'],
  ['V3HubReqInbound02Normalized', 'v3/crates/routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs', 'build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01'],
  ['V3HubReqContinuation03Classified', 'v3/crates/routecodex-v3-runtime/src/hub_v1/req_continuation_03_classified.rs', 'build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02'],
  ['V3HubReqChatProcess04Governed', 'v3/crates/routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs', 'build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03'],
  ['V3HubReqExecution05Planned', 'v3/crates/routecodex-v3-runtime/src/hub_v1/req_execution_05_planned.rs', 'build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04'],
  ['V3HubReqTarget06Resolved', 'v3/crates/routecodex-v3-runtime/src/hub_v1/req_target_06_resolved.rs', 'build_v3_hub_req_target_06_from_v3_hub_req_execution_05'],
  ['V3HubReqOutbound07ProviderSemantic', 'v3/crates/routecodex-v3-runtime/src/hub_v1/req_outbound_07_provider_semantic.rs', 'build_v3_hub_req_outbound_07_from_v3_hub_req_target_06'],
  ['ProviderReqCompat06ProviderCompat', 'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs', 'build_provider_req_compat_06_from_v3_hub_req_outbound_07'],
  ['V3ProviderReqOutbound08WirePayload', 'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_req_outbound_08_wire_payload.rs', 'build_v3_provider_req_outbound_08_from_provider_req_compat_06'],
  ['V3ProviderReqOutbound09TransportRequest', 'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_req_outbound_09_transport_request.rs', 'build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08'],
  ['V3ProviderRespInbound01Raw', 'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_resp_inbound_01_raw.rs', 'build_v3_provider_resp_inbound_01_raw'],
  ['ProviderRespCompat02ProviderCompat', 'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_resp_compat_02_provider_compat.rs', 'build_provider_resp_compat_02_from_v3_provider_resp_inbound_01'],
  ['V3HubRespInbound02Normalized', 'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_inbound_02_normalized.rs', 'build_v3_hub_resp_inbound_02_from_provider_resp_compat_02'],
  ['V3HubRespChatProcess03Governed', 'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs', 'build_v3_hub_resp_chat_process_03_from_v3_hub_resp_inbound_02'],
  ['V3HubRespContinuation04Committed', 'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs', 'build_v3_hub_resp_continuation_04_from_v3_hub_resp_chat_process_03'],
  ['V3HubRespOutbound05ClientSemantic', 'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_outbound_05_client_semantic.rs', 'build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04'],
  ['V3ServerRespOutbound06ClientFrame', 'v3/crates/routecodex-v3-runtime/src/hub_v1/server_resp_outbound_06_client_frame.rs', 'build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05'],
].map(([node, ownerFile, builderSymbol]) => ({ node, ownerFile, builderSymbol }));

const SHARED_HELPERS = [
  'v3/crates/routecodex-v3-runtime/src/hub_v1/common.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/side_channel.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_compat_shared.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs',
];

const EXPECTED_FIXED_EDGES = new Map([
  ['v3-hub-req-01', ['V3HubReqInbound01ClientRaw', 'V3HubReqInbound02Normalized', 'build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01']],
  ['v3-hub-req-02', ['V3HubReqInbound02Normalized', 'V3HubReqContinuation03Classified', 'build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02']],
  ['v3-hub-req-03', ['V3HubReqContinuation03Classified', 'V3HubReqChatProcess04Governed', 'build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03']],
  ['v3-hub-req-04', ['V3HubReqChatProcess04Governed', 'V3HubReqExecution05Planned', 'build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04']],
  ['v3-hub-req-05', ['V3HubReqExecution05Planned', 'V3HubReqTarget06Resolved', 'build_v3_hub_req_target_06_from_v3_hub_req_execution_05']],
  ['v3-hub-req-06', ['V3HubReqTarget06Resolved', 'V3HubReqOutbound07ProviderSemantic', 'build_v3_hub_req_outbound_07_from_v3_hub_req_target_06']],
  ['v3-hub-req-07', ['V3HubReqOutbound07ProviderSemantic', 'ProviderReqCompat06ProviderCompat', 'build_provider_req_compat_06_from_v3_hub_req_outbound_07']],
  ['v3-hub-req-08', ['ProviderReqCompat06ProviderCompat', 'V3ProviderReqOutbound08WirePayload', 'build_v3_provider_req_outbound_08_from_provider_req_compat_06']],
  ['v3-hub-req-09', ['V3ProviderReqOutbound08WirePayload', 'V3ProviderReqOutbound09TransportRequest', 'build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08']],
  ['v3-hub-resp-01', ['V3ProviderRespInbound01Raw', 'ProviderRespCompat02ProviderCompat', 'build_provider_resp_compat_02_from_v3_provider_resp_inbound_01']],
  ['v3-hub-resp-02', ['ProviderRespCompat02ProviderCompat', 'V3HubRespInbound02Normalized', 'build_v3_hub_resp_inbound_02_from_provider_resp_compat_02']],
  ['v3-hub-resp-03', ['V3HubRespInbound02Normalized', 'V3HubRespChatProcess03Governed', 'build_v3_hub_resp_chat_process_03_from_v3_hub_resp_inbound_02']],
  ['v3-hub-resp-04', ['V3HubRespChatProcess03Governed', 'V3HubRespContinuation04Committed', 'build_v3_hub_resp_continuation_04_from_v3_hub_resp_chat_process_03']],
  ['v3-hub-resp-05', ['V3HubRespContinuation04Committed', 'V3HubRespOutbound05ClientSemantic', 'build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04']],
  ['v3-hub-resp-06', ['V3HubRespOutbound05ClientSemantic', 'V3ServerRespOutbound06ClientFrame', 'build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05']],
]);

function rel(file) {
  return file.split(path.sep).join('/');
}

function abs(file) {
  return path.join(root, file);
}

function fail(message) {
  failures.push(message);
}

function read(file) {
  try {
    return fs.readFileSync(abs(file), 'utf8');
  } catch (error) {
    fail(`${file}: cannot read: ${error.message}`);
    return '';
  }
}

function parseYaml(file) {
  try {
    return YAML.parse(read(file));
  } catch (error) {
    fail(`${file}: YAML parse failed: ${error.message}`);
    return {};
  }
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rustFiles(dir) {
  const out = [];
  if (!fs.existsSync(abs(dir))) return out;
  for (const entry of fs.readdirSync(abs(dir))) {
    const file = path.join(dir, entry);
    if (fs.statSync(abs(file)).isFile() && file.endsWith('.rs')) out.push(rel(file));
  }
  return out.sort();
}

const sourceFiles = [
  ROOT_FILE,
  ...rustFiles('v3/crates/routecodex-v3-runtime/src/hub_v1'),
  ...rustFiles('v3/crates/routecodex-v3-runtime/tests'),
].filter((file, index, arr) => arr.indexOf(file) === index);

function typeDefinitionPattern(symbol) {
  const escaped = escapeRegExp(symbol);
  return new RegExp(
    `(?:^|\\n)\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:struct|enum|type)\\s+${escaped}\\b`,
    'm'
  );
}

function fnDefinitionPattern(symbol) {
  const escaped = escapeRegExp(symbol);
  return new RegExp(
    `(?:^|\\n)\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${escaped}\\b`,
    'm'
  );
}

function filesMatching(pattern) {
  return sourceFiles.filter((file) => fs.existsSync(abs(file)) && pattern.test(read(file)));
}

function typeDefinitionFiles(symbol) {
  return filesMatching(typeDefinitionPattern(symbol));
}

function fnDefinitionFiles(symbol) {
  return filesMatching(fnDefinitionPattern(symbol));
}

function symbolDefinitionFiles(symbol) {
  const raw = String(symbol ?? '');
  const base = raw.split('::')[0];
  if (!base) return [];
  if (raw.includes('::')) return typeDefinitionFiles(base);
  const fnDefs = fnDefinitionFiles(base);
  return fnDefs.length ? fnDefs : typeDefinitionFiles(base);
}

function checkFileExists(file) {
  if (!fs.existsSync(abs(file))) fail(`${file}: missing`);
}

for (const file of [ROOT_FILE, FUNCTION_MAP, MAINLINE_MAP, VERIFICATION_MAP, DESIGN_DOC, ...SHARED_HELPERS]) {
  checkFileExists(file);
}

const rootSource = read(ROOT_FILE);
for (const [index, line] of rootSource.split('\n').entries()) {
  if (/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum)\s+\w+|^\s*(?:pub(?:\([^)]*\))?\s+)?impl(?:<[^>]*>)?\s+/.test(line)) {
    fail(`${ROOT_FILE}:${index + 1}: root aggregator must stay declaration/reexport-only`);
  }
}

const nodeByBuilder = new Map();
for (const owner of NODE_OWNERS) {
  nodeByBuilder.set(owner.builderSymbol, owner);
  checkFileExists(owner.ownerFile);
  const nodeDefs = typeDefinitionFiles(owner.node);
  const builderDefs = fnDefinitionFiles(owner.builderSymbol);
  if (nodeDefs.length !== 1 || nodeDefs[0] !== owner.ownerFile) {
    fail(`${owner.node}: expected one definition in ${owner.ownerFile}, got ${nodeDefs.join(', ') || 'none'}`);
  }
  if (builderDefs.length !== 1 || builderDefs[0] !== owner.ownerFile) {
    fail(`${owner.builderSymbol}: expected one definition in ${owner.ownerFile}, got ${builderDefs.join(', ') || 'none'}`);
  }
}

for (const helper of SHARED_HELPERS) {
  const text = read(helper);
  for (const owner of NODE_OWNERS) {
    if (typeDefinitionPattern(owner.node).test(text)) fail(`${helper}: shared helper must not define node ${owner.node}`);
    if (fnDefinitionPattern(owner.builderSymbol).test(text)) fail(`${helper}: shared helper must not define builder ${owner.builderSymbol}`);
  }
}

const functionMap = parseYaml(FUNCTION_MAP);
const mainlineMap = parseYaml(MAINLINE_MAP);
const verificationMap = parseYaml(VERIFICATION_MAP);
const designDoc = read(DESIGN_DOC);
const packageJson = JSON.parse(read('package.json') || '{}');

const h1Function = array(functionMap.features).find((entry) => entry?.feature_id === 'v3.hub_pipeline_static_skeleton');
if (!h1Function) {
  fail(`${FUNCTION_MAP}: missing feature v3.hub_pipeline_static_skeleton`);
} else {
  if (h1Function.module_export_owner_file !== ROOT_FILE) fail(`${FUNCTION_MAP}: H1 module_export_owner_file must be ${ROOT_FILE}`);
  if (h1Function.provider_compat_branch_numbering !== 'branch_local_contract_number') {
    fail(`${FUNCTION_MAP}: H1 provider_compat_branch_numbering must be branch_local_contract_number`);
  }
  const mappedNodes = new Map(array(h1Function.node_owner_files).map((entry) => [entry?.node, entry]));
  for (const owner of NODE_OWNERS) {
    const row = mappedNodes.get(owner.node);
    if (!row) {
      fail(`${FUNCTION_MAP}: H1 node_owner_files missing ${owner.node}`);
      continue;
    }
    if (row.owner_file !== owner.ownerFile) fail(`${FUNCTION_MAP}: ${owner.node} owner_file must be ${owner.ownerFile}`);
    if (row.builder_symbol !== owner.builderSymbol) fail(`${FUNCTION_MAP}: ${owner.node} builder_symbol must be ${owner.builderSymbol}`);
  }
  const extraNodes = [...mappedNodes.keys()].filter((node) => !NODE_OWNERS.some((owner) => owner.node === node));
  if (extraNodes.length) fail(`${FUNCTION_MAP}: H1 node_owner_files contains undeclared nodes: ${extraNodes.join(', ')}`);
  const mappedHelpers = new Set(array(h1Function.shared_helper_owner_files).map((entry) => entry?.file));
  for (const helper of SHARED_HELPERS) {
    if (!mappedHelpers.has(helper)) fail(`${FUNCTION_MAP}: H1 shared_helper_owner_files missing ${helper}`);
  }
  const allowedPaths = new Set(array(h1Function.allowed_paths));
  for (const requiredPath of [
    ROOT_FILE,
    ...NODE_OWNERS.map((owner) => owner.ownerFile),
    ...SHARED_HELPERS,
    DESIGN_DOC,
    FUNCTION_MAP,
    MAINLINE_MAP,
    VERIFICATION_MAP,
    VERIFY_SCRIPT,
    RED_SCRIPT,
    'package.json',
  ]) {
    if (!allowedPaths.has(requiredPath)) fail(`${FUNCTION_MAP}: H1 allowed_paths missing ${requiredPath}`);
  }
  for (const gate of REQUIRED_GATES) {
    if (!array(h1Function.required_gates).includes(gate)) fail(`${FUNCTION_MAP}: H1 required_gates missing ${gate}`);
  }
}

const h1Verification = array(verificationMap.features).find((entry) => entry?.feature_id === 'v3.hub_pipeline_static_skeleton');
if (!h1Verification) {
  fail(`${VERIFICATION_MAP}: missing feature v3.hub_pipeline_static_skeleton`);
} else {
  for (const gate of REQUIRED_GATES) {
    if (!array(h1Verification.required_gates).includes(gate)) fail(`${VERIFICATION_MAP}: H1 required_gates missing ${gate}`);
  }
  for (const phrase of [
    'each V3 Hub contract node has exactly one split owner file',
    'hub_v1.rs is only the module declaration/reexport surface',
    'shared helper files have explicit owner boundaries',
    'provider compat numbering is branch-local contract numbering',
  ]) {
    if (!array(h1Verification.required_contract).some((entry) => String(entry).includes(phrase))) {
      fail(`${VERIFICATION_MAP}: H1 required_contract missing "${phrase}"`);
    }
  }
}

for (const [scriptName, expected] of [
  ['verify:v3-hub-v1-node-file-topology', `node ${VERIFY_SCRIPT}`],
  ['test:v3-hub-v1-node-file-topology-red-fixtures', `node ${RED_SCRIPT}`],
]) {
  if (packageJson.scripts?.[scriptName] !== expected) {
    fail(`package.json: script ${scriptName} must be ${expected}`);
  }
}

for (const phrase of [
  'V3 Hub v1 node-file topology',
  'hub_v1.rs` 是 V3 Hub v1 的根聚合面',
  'ProviderReqCompat06ProviderCompat',
  'branch-local contract numbering',
  'Shared helper owner boundary',
  'verify:v3-hub-v1-node-file-topology',
]) {
  if (!designDoc.includes(phrase)) fail(`${DESIGN_DOC}: missing topology phrase ${phrase}`);
}

const chains = array(mainlineMap.chains);
const allEdges = chains.flatMap((chain) => array(chain.edges).map((edge) => ({ chainId: chain.chain_id, edge })));
for (const [stepId, [fromNode, toNode, builderSymbol]] of EXPECTED_FIXED_EDGES.entries()) {
  const row = allEdges.find(({ edge }) => edge?.step_id === stepId)?.edge;
  if (!row) {
    fail(`${MAINLINE_MAP}: missing fixed edge ${stepId}`);
    continue;
  }
  const owner = nodeByBuilder.get(builderSymbol);
  if (row.from_node !== fromNode || row.to_node !== toNode) {
    fail(`${MAINLINE_MAP}: ${stepId} must remain adjacent ${fromNode} -> ${toNode}`);
  }
  if (row.callee_symbol !== builderSymbol) fail(`${MAINLINE_MAP}: ${stepId} callee_symbol must be ${builderSymbol}`);
  if (row.callee_file !== owner.ownerFile) fail(`${MAINLINE_MAP}: ${stepId} callee_file must be ${owner.ownerFile}`);
  if (row.caller_symbol === 'all_adjacent_builders_form_the_fixed_typed_topology' && row.caller_file !== TEST_TOPOLOGY_FILE) {
    fail(`${MAINLINE_MAP}: ${stepId} synthetic caller_file must be ${TEST_TOPOLOGY_FILE}`);
  }
}

let checkedMainlineBindings = 0;
for (const { edge } of allEdges) {
  for (const kind of ['caller', 'callee']) {
    const symbol = edge?.[`${kind}_symbol`];
    const file = edge?.[`${kind}_file`];
    if (!symbol || !file) continue;
    if (
      !String(file).startsWith('v3/crates/routecodex-v3-runtime/src/hub_v1') &&
      !String(file).startsWith('v3/crates/routecodex-v3-runtime/tests/')
    ) {
      continue;
    }
    checkedMainlineBindings += 1;
    if (file === ROOT_FILE) {
      fail(`${MAINLINE_MAP}: ${edge.step_id} ${kind}_file points to root aggregator for ${symbol}`);
      continue;
    }
    const defs = symbolDefinitionFiles(symbol);
    if (defs.length === 1 && defs[0] !== file) {
      fail(`${MAINLINE_MAP}: ${edge.step_id} ${kind}_file ${file} does not match ${symbol} definition ${defs[0]}`);
    } else if (defs.length > 1) {
      if (nodeByBuilder.has(symbol)) {
        fail(`${MAINLINE_MAP}: ${edge.step_id} ${kind}_symbol ${symbol} has duplicate definitions: ${defs.join(', ')}`);
      } else if (!defs.includes(file)) {
        fail(`${MAINLINE_MAP}: ${edge.step_id} ${kind}_file ${file} is not one of ${symbol} definitions: ${defs.join(', ')}`);
      }
    } else if (defs.length === 0 && String(file).includes('/hub_v1')) {
      fail(`${MAINLINE_MAP}: ${edge.step_id} ${kind}_symbol ${symbol} has no definition in Hub v1 sources/tests`);
    }
  }
}

if (failures.length) {
  console.error('[verify:v3-hub-v1-node-file-topology] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:v3-hub-v1-node-file-topology] ok');
console.log(`- contract nodes: ${NODE_OWNERS.length}`);
console.log(`- shared helpers: ${SHARED_HELPERS.length}`);
console.log(`- checked Hub V1 mainline bindings: ${checkedMainlineBindings}`);
