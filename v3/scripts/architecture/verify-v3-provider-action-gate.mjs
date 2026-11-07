#!/usr/bin/env node
// Static Provider-observation bindings only. Public HTTP tests own behavior.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = process.env.ROUTECODEX_V3_SOURCE_ROOT
  ? path.resolve(process.env.ROUTECODEX_V3_SOURCE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const yaml = (rel) => YAML.parse(read(rel));
const manifestPath = 'docs/architecture/manifests/v3.provider_action_gate.mainline.yml';
const manifest = yaml(manifestPath);
const featureId = 'v3.provider_action_gate';
const chain = yaml('docs/architecture/v3-mainline-call-map.yml').chains
  .find((row) => row.chain_id === manifest.lifecycle_id);
const feature = yaml('docs/architecture/v3-function-map.yml').features
  .find((row) => row.feature_id === featureId);
const verification = yaml('docs/architecture/v3-verification-map.yml').features
  .find((row) => row.feature_id === featureId);
const resource = yaml('docs/architecture/v3-resource-operation-map.yml').resources
  .find((row) => row.resource_id === 'v3.error.provider_action_gate');
const failures = [];
const require = (condition, message) => { if (!condition) failures.push(message); };
const ids = (edges = []) => edges.map((edge) => edge.step_id).sort();
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const manifestIds = ids(manifest.edges);

require(manifest.owner_feature === featureId, 'manifest must retain the Provider observation owner');
require(chain && chain.owner_feature_id === featureId, 'missing Provider observation call chain');
require(equal(ids(chain?.edges), manifestIds), 'manifest and call-map edge bindings differ');
require(equal([...(feature?.mainline_bindings ?? [])].sort(), manifestIds), 'function-map bindings differ');
require(equal([...(verification?.mainline_bindings ?? [])].sort(), manifestIds), 'verification-map bindings differ');
require(manifest.request_independence?.lifecycle_scope === 'listener_provider_interface_model_auth_key', 'observations require the complete listener identity');
for (const name of ['request_waiter', 'request_admission', 'request_recovery_witness', 'request_lease']) {
  require(manifest.request_independence?.[name] === 'forbidden', `${name} must remain forbidden`);
}
require(resource?.resource_kind === 'provider_lifecycle_control_side_channel', 'resource must belong only to Provider lifecycle');
require(resource?.owner_node === 'V3ProviderObservationState', 'resource has a stale request admission owner');
require(manifest.observation_lease?.owner_type === 'V3ProviderObservationLease', 'missing Provider observation lease owner');
require(manifest.observation_lease?.holder === 'V3PrecoolObservationGuard', 'only precool owns the observation lease');

for (const edge of manifest.edges ?? []) {
  const bound = chain?.edges?.find((row) => row.step_id === edge.step_id);
  for (const field of ['caller_symbol', 'caller_file', 'callee_symbol', 'callee_file', 'owner_feature_id']) {
    require(bound?.[field] === edge[field], `${edge.step_id}: ${field} differs`);
  }
  require(bound?.from_node === edge.from && bound?.to_node === edge.to, `${edge.step_id}: endpoints differ`);
  require(edge.status === 'anchored' && bound?.status === 'anchored', `${edge.step_id}: unanchored edge`);
  for (const field of ['caller_file', 'callee_file']) {
    require(fs.existsSync(path.join(root, edge[field])), `${edge.step_id}: missing ${field}`);
  }
}

const source = read('v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs');
for (const retired of ['V3ProviderActionWaiter', 'V3ProviderActionAdmission', 'V3ProviderActionPermit', 'V3ExactRateLimitAdmission']) {
  require(!new RegExp(`\\b(?:struct|enum)\\s+${retired}\\b`, 'u').test(source), `retired request control revived: ${retired}`);
}
for (const retired of ['wait_for_active_failure', 'wait_for_recovery_witness', 'wait_for_recovery_ticket', 'try_admit_exact_rate_limit', 'commit_terminal_admission']) {
  require(!new RegExp(`\\bfn\\s+${retired}\\b`, 'u').test(source), `retired request API revived: ${retired}`);
}
if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('PASS: Provider observation static bindings; runtime behavior requires public-entry evidence.\n');
}
