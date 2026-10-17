#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = process.env.ROUTECODEX_V3_SOURCE_ROOT
  ? path.resolve(process.env.ROUTECODEX_V3_SOURCE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const manifestFile = 'docs/architecture/manifests/v3.hub_relay.tool_servertool_multiturn_parity.mainline.yml';
const read = (file) => YAML.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const manifest = read(manifestFile);
const functions = read('docs/architecture/v3-function-map.yml');
const calls = read('docs/architecture/v3-mainline-call-map.yml');
const verification = read('docs/architecture/v3-verification-map.yml');
const resources = read('docs/architecture/v3-resource-operation-map.yml');
const featureId = 'v3.relay_tool_servertool_multiturn_parity_closeout';
const lifecycleId = 'v3.hub_relay.tool_servertool_multiturn_parity';
const steps = ['v3-relay-tool-parity-01', 'v3-relay-tool-parity-02', 'v3-relay-tool-parity-04', 'v3-relay-tool-parity-05', 'v3-relay-tool-parity-06'];
const failures = [];
const requireValue = (condition, message) => { if (!condition) failures.push(message); };
requireValue(manifest.lifecycle_id === lifecycleId && manifest.call_map_chain_id === lifecycleId, 'manifest lifecycle/call-map mismatch');
requireValue(manifest.owner_feature_id === featureId, 'manifest owner_feature_id mismatch');
const feature = functions.features?.find((row) => row.feature_id === featureId);
const chain = calls.chains?.find((row) => row.chain_id === lifecycleId);
requireValue(Boolean(feature) && chain?.owner_feature_id === featureId, 'parity lifecycle must bind its function and mainline owner');
const bound = new Map((chain?.edges ?? []).map((edge) => [edge.step_id, edge]));
requireValue(manifest.edges?.length === steps.length, 'manifest must declare its parity edges');
for (const [index, step] of steps.entries()) {
  const edge = manifest.edges?.[index];
  const actual = bound.get(step);
  requireValue(edge?.step_id === step && edge?.owner_feature_id === featureId && edge?.status === 'anchored', `manifest edge ${step} mismatch`);
  requireValue(actual?.owner_feature_id === featureId && actual?.from_node === edge?.from_node && actual?.to_node === edge?.to_node && actual?.status === 'anchored', `mainline edge ${step} owner/endpoints mismatch`);
  requireValue(feature?.mainline_bindings?.includes(step), `function owner must bind ${step}`);
}
requireValue(feature?.resource_bindings?.includes('v3.hub.tool_governance_truth') && resources.resources?.some((row) => row.resource_id === 'v3.hub.tool_governance_truth'), 'parity owner must bind tool governance resource');
requireValue(verification.features?.find((row) => row.feature_id === featureId)?.contract?.includes(manifestFile), 'verification owner must bind parity manifest');
const resp03Id = 'v3.resp03_tool_governance_gap_closeout';
requireValue(functions.features?.some((row) => row.feature_id === resp03Id) && verification.features?.some((row) => row.feature_id === resp03Id), 'Resp03 governance owner must exist in function/verification maps');
const resp03 = calls.chains?.find((row) => row.chain_id === resp03Id);
for (const step of ['v3-resp03-tool-governance-01', 'v3-resp03-tool-governance-06']) {
  requireValue(resp03?.edges?.some((edge) => edge.step_id === step), `Resp03 governance chain must bind ${step}`);
}
if (failures.length) {
  console.error('[verify:v3-relay-tool-servertool-multiturn-parity-closeout] failed');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log('[verify:v3-relay-tool-servertool-multiturn-parity-closeout] declared owners/resources/edges ok');
