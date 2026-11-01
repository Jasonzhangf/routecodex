#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const manifestPath = 'docs/architecture/manifests/v3.anthropic_relay.controlled_runtime.mainline.yml';
const callMapPath = 'docs/architecture/v3-mainline-call-map.yml';
const repoRoot = [
  process.cwd(),
  resolve(process.cwd(), '..'),
  resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
].find((candidate) => existsSync(resolve(candidate, manifestPath)));
if (!repoRoot) throw new Error('RouteCodex repository root not found');
const readYaml = (relative) => YAML.parse(readFileSync(resolve(repoRoot, relative), 'utf8'));
const manifest = readYaml(manifestPath);
const callMap = readYaml(callMapPath);
const failures = [];
const expectedManifestNodes = [
  'V3ServerValidatedMessagesRequest',
  'V3HubReqInbound01ClientRaw', 'V3HubReqInbound02Normalized',
  'V3HubReqChatProcess04Governed',
  'V3HubReqExecution05Planned', 'V3HubReqTarget06Resolved',
  'V3HubReqOutbound07ProviderSemantic', 'ProviderReqCompat06ProviderCompat',
  'V3ProviderReqOutbound08WirePayload',
  'V3ProviderReqOutbound09TransportRequest', 'V3ProviderRespInbound01Raw',
  'ProviderRespCompat02ProviderCompat', 'V3HubRespInbound02Normalized',
  'V3HubRespChatProcess03Governed',
  'V3HubRespOutbound05ClientSemantic',
  'V3ServerRespOutbound06ClientFrame',
];
if (manifest.lifecycle_id !== 'v3.anthropic_relay.controlled_runtime') {
  failures.push(`${manifestPath}: lifecycle_id mismatch`);
}
if (manifest.owner_feature_id !== 'v3.anthropic_relay_runtime_integration') {
  failures.push(`${manifestPath}: owner_feature_id mismatch`);
}
if (JSON.stringify(manifest.node_ids) !== JSON.stringify(expectedManifestNodes)) {
  failures.push(`${manifestPath}: fixed node order mismatch`);
}
const manifestEdges = Array.isArray(manifest.edges) ? manifest.edges : [];
const expectedStepIds = [
  'v3-anthropic-relay-01',
  'v3-anthropic-relay-02',
  'v3-anthropic-relay-03',
  'v3-anthropic-relay-05',
  'v3-anthropic-relay-06',
  'v3-anthropic-relay-07',
  'v3-anthropic-relay-08',
  'v3-anthropic-relay-09',
  'v3-anthropic-relay-10',
  'v3-anthropic-relay-11',
  'v3-anthropic-relay-12',
  'v3-anthropic-relay-13',
  'v3-anthropic-relay-14',
  'v3-anthropic-relay-15',
  'v3-anthropic-relay-16',
];
if (manifestEdges.length !== expectedStepIds.length) {
  failures.push(`${manifestPath}: expected 15 adjacent edges`);
}
for (let index = 0; index < manifestEdges.length; index += 1) {
  const edge = manifestEdges[index];
  const expectedStep = expectedStepIds[index];
  if (edge.step_id !== expectedStep
      || edge.from_node !== expectedManifestNodes[index]
      || edge.to_node !== expectedManifestNodes[index + 1]
      || edge.status !== 'anchored') {
    failures.push(`${manifestPath}: edge ${expectedStep} mismatch`);
  }
}
if (manifest.entrypoint?.node_id !== expectedManifestNodes[0]
    || manifest.return_path?.node_id !== expectedManifestNodes.at(-1)
    || manifest.call_map_chain_id !== manifest.lifecycle_id) {
  failures.push(`${manifestPath}: entrypoint/return/call-map binding mismatch`);
}
const callMapChain = callMap.chains?.find(
  (chain) => chain.chain_id === 'v3.anthropic_relay.controlled_runtime',
);
if (!callMapChain) {
  failures.push(`${callMapPath}: missing v3.anthropic_relay.controlled_runtime`);
} else {
  const expectedCallees = new Map([
    ['v3-anthropic-relay-12', 'build_provider_resp_compat_02_from_v3_provider_resp_inbound_01'],
    ['v3-anthropic-relay-15', 'build_v3_hub_resp_outbound_05_from_v3_hub_resp_chat_process_03'],
    ['v3-anthropic-relay-16', 'build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05'],
  ]);
  for (const [stepId, calleeSymbol] of expectedCallees) {
    const edge = callMapChain.edges?.find((candidate) => candidate.step_id === stepId);
    if (edge?.callee_symbol !== calleeSymbol) {
      failures.push(`${callMapPath}: ${stepId} must call ${calleeSymbol}`);
    }
  }
}

if (failures.length) {
  console.error('[verify:v3-anthropic-relay-runtime-integration] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-anthropic-relay-runtime-integration] manifest/call-map bindings ok');
