#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import YAML from 'yaml';

const root = process.env.ROUTECODEX_V3_SOURCE_ROOT
  ? path.resolve(process.env.ROUTECODEX_V3_SOURCE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const file = 'docs/architecture/manifests/v3.hub_relay.runtime_closeout.mainline.yml';
const read = (relative) => YAML.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const manifest = read(file);
const functions = read('docs/architecture/v3-function-map.yml');
const calls = read('docs/architecture/v3-mainline-call-map.yml');
const verification = read('docs/architecture/v3-verification-map.yml');
const lifecycle = 'v3.hub_relay.runtime_closeout';
const owner = 'v3.hub_relay_runtime_closeout';
const nodes = [
  'V3HubReqInbound01ClientRaw', 'V3HubReqInbound02Normalized',
  'V3HubReqChatProcess04Governed', 'V3HubReqExecution05Planned',
  'V3HubReqTarget06Resolved', 'V3HubReqOutbound07ProviderSemantic',
  'ProviderReqCompat06ProviderCompat', 'V3ProviderReqOutbound08WirePayload',
  'V3ProviderReqOutbound09TransportRequest', 'V3ProviderRespInbound01Raw',
  'ProviderRespCompat02ProviderCompat', 'V3HubRespInbound02Normalized',
  'V3HubRespChatProcess03Governed', 'V3HubRespOutbound05ClientSemantic',
  'V3ServerRespOutbound06ClientFrame',
];
const errorNodes = ['V3Error01SourceRaised', 'V3Error02Classified', 'V3Error03TargetLocalAction', 'V3Error04TargetExhaustionDecision', 'V3Error05ExecutionDecision', 'V3Error06ClientProjected'];
const failures = [];
const requireValue = (condition, message) => { if (!condition) failures.push(message); };
requireValue(manifest.lifecycle_id === lifecycle && manifest.call_map_chain_id === lifecycle, 'manifest lifecycle/call-map binding mismatch');
requireValue(manifest.owner_feature_id === owner, 'manifest owner_feature_id mismatch');
requireValue(isDeepStrictEqual(manifest.node_ids, nodes), 'manifest fixed node order mismatch');
requireValue(manifest.entrypoint?.node_id === nodes[0] && manifest.return_path?.node_id === nodes.at(-1), 'manifest entry/return binding mismatch');
requireValue(manifest.edges?.length === nodes.length - 1, 'manifest must declare adjacent closeout edges');
const chain = calls.chains?.find((row) => row.chain_id === lifecycle);
const feature = functions.features?.find((row) => row.feature_id === owner);
requireValue(chain?.owner_feature_id === owner && Boolean(feature), 'closeout must bind function and mainline owner');
const bound = new Map((chain?.edges ?? []).map((edge) => [edge.step_id, edge]));
for (let index = 0; index < nodes.length - 1; index += 1) {
  const step = `v3-hub-relay-closeout-${String(index + 1).padStart(2, '0')}`;
  const edge = manifest.edges?.[index];
  requireValue(edge?.step_id === step && edge?.from_node === nodes[index] && edge?.to_node === nodes[index + 1] && edge?.owner_feature_id === owner && edge?.status === 'anchored', `manifest edge ${step} mismatch`);
  const actual = bound.get(step);
  requireValue(actual?.from_node === nodes[index] && actual?.to_node === nodes[index + 1] && actual?.owner_feature_id === owner, `mainline edge ${step} mismatch`);
}
requireValue(verification.features?.find((row) => row.feature_id === owner)?.contract?.includes(file), 'verification owner must bind closeout manifest');
requireValue(isDeepStrictEqual(manifest.error_path?.canonical_nodes, errorNodes), 'Resp03 failure must enter complete Error01-Error06 declaration');
const errorEdge = manifest.error_path?.entry_edge;
requireValue(errorEdge?.step_id === 'v3-hub-relay-response-failure-01' && errorEdge?.from_node === 'V3HubRespChatProcess03Governed' && errorEdge?.to_node === errorNodes[0], 'manifest Resp03 failure entry mismatch');
const failureChain = calls.chains?.find((row) => row.chain_id === 'v3.hub_relay.response_failure_entry');
const failureEdge = failureChain?.edges?.find((row) => row.step_id === 'v3-hub-relay-response-failure-01');
requireValue(Boolean(failureEdge), 'missing v3-hub-relay-response-failure-01');
for (const [field, expected] of Object.entries({
  from_node: 'V3HubRespChatProcess03Governed',
  to_node: 'V3Error01SourceRaised',
  caller_symbol: 'build_v3_relay_provider_attempt_source',
  caller_file: 'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs',
  callee_symbol: 'build_v3_error_01_source_raised_external',
  callee_file: 'v3/crates/routecodex-v3-error/src/lib.rs',
})) requireValue(failureEdge?.[field] === expected, `failure entry ${field} must equal ${expected}`);
const entryChain = calls.chains?.find((row) => row.chain_id === 'v3.responses_relay.source_server_entry');
for (const step of ['v3-responses-relay-server-01', 'v3-responses-relay-server-04']) {
  requireValue(entryChain?.edges?.some((edge) => edge.step_id === step), `source server entry must bind ${step}`);
}
if (failures.length) {
  console.error('[verify:v3-hub-relay-runtime-closeout] failed');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log('[verify:v3-hub-relay-runtime-closeout] declared topology/error/owner bindings ok');
