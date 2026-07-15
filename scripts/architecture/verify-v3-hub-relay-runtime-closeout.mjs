#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

const runtimePath = 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs';
const testPath = 'v3/crates/routecodex-v3-runtime/tests/hub_relay_runtime_closeout.rs';
const manifestPath = 'docs/architecture/manifests/v3.hub_relay.runtime_closeout.mainline.yml';
const functionMapPath = 'docs/architecture/v3-function-map.yml';
const mainlinePath = 'docs/architecture/v3-mainline-call-map.yml';
const verificationPath = 'docs/architecture/v3-verification-map.yml';
const wikiPath = 'docs/architecture/wiki/v3-hub-relay-fixed-pipeline.md';
const packagePath = 'package.json';

const runtime = readFileSync(runtimePath, 'utf8');
const tests = readFileSync(testPath, 'utf8');
const manifest = YAML.parse(readFileSync(manifestPath, 'utf8'));
const functionMap = readFileSync(functionMapPath, 'utf8');
const mainline = readFileSync(mainlinePath, 'utf8');
const verification = readFileSync(verificationPath, 'utf8');
const wiki = readFileSync(wikiPath, 'utf8');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
const failures = [];

const expectedNodes = [
  'V3HubReqInbound01ClientRaw',
  'V3HubReqInbound02Normalized',
  'V3HubReqContinuation03Classified',
  'V3HubReqChatProcess04Governed',
  'V3HubReqExecution05Planned',
  'V3HubReqTarget06Resolved',
  'V3HubReqOutbound07ProviderSemantic',
  'V3ProviderReqOutbound08WirePayload',
  'V3ProviderReqOutbound09TransportRequest',
  'V3ProviderRespInbound01Raw',
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
  failures.push(`${manifestPath}: expected 14 adjacent closeout edges`);
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

for (const script of [
  'test:v3-hub-relay-runtime-closeout',
  'verify:v3-hub-relay-runtime-closeout',
  'test:v3-hub-relay-runtime-closeout-red-fixtures',
  'test:v3-relay-payload-copy-runtime-probes',
  'verify:v3-relay-payload-copy-budget',
  'test:v3-relay-payload-copy-budget-red-fixtures',
]) {
  if (!packageJson.scripts?.[script]) failures.push(`${packagePath}: missing script ${script}`);
}

requireText(runtime, runtimePath, 'execute_v3_anthropic_relay_runtime_with_local_continuation_and_servertool_profile');
requireText(runtime, runtimePath, 'response_hook_profile: V3HubRelayResponseHookProfile');
requireCount(runtime, runtimePath, 'hooks.govern(resp02, &response_hook_profile)?', 2);
requireCount(runtime, runtimePath, 'let resp04 = hooks.commit(resp03)?;', 2);
requireCount(runtime, runtimePath, 'build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04)', 2);
requireCount(runtime, runtimePath, 'build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05)', 2);
requireOrdered(
  runtime,
  runtimePath,
  'let resp04 = hooks.commit(resp03)?;',
  'build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04)',
  2,
);
requireText(runtime, runtimePath, 'servertool_followup_required');
forbid(runtime, runtimePath, [
  /hooks\.govern\(resp02,\s*&V3HubRelayResponseHookProfile::empty\(\)\)/,
  /fallback/i,
  /ResponsesDirect(?:Runtime|11Policy)|execute_v3_responses_direct/i,
  /dynamic[_ -]?hook|libloading|read_dir/i,
  /build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04[\s\S]{0,240}hooks\.commit\(resp03\)/,
]);

for (const phrase of [
  'EXPECTED_RELAY_TRACE',
  'controlled_json_and_sse_e2e_use_fixed_topology_and_one_response_exit',
  'local_continuation_servertool_roundtrip_is_runtime_e2e',
  'provider_error_closeout_enters_error01_06_without_success_projection',
  'execute_v3_anthropic_relay_runtime_with_local_continuation_and_servertool_profile',
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
  /collect\s*::<\s*Vec|full_buffer|materiali[sz]e/i,
]);

for (const [path, text] of [
  [functionMapPath, functionMap],
  [mainlinePath, mainline],
  [verificationPath, verification],
  [wikiPath, wiki],
]) {
  requireText(text, path, 'v3.hub_relay_runtime_closeout');
  requireText(text, path, 'v3-hub-relay-closeout-01');
  requireText(text, path, 'v3-hub-relay-closeout-14');
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

function forbid(text, owner, patterns) {
  for (const pattern of patterns) {
    if (pattern.test(text)) failures.push(`${owner}: forbidden ${pattern}`);
  }
}
