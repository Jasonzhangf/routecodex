import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  MAINLINE_CALL_MAP_PATH,
  validateMainlineCallMap,
  loadFeatureOwners,
} from './mainline-call-map-lib.mjs';

const root = process.cwd();
const manifestDir = path.join(root, 'docs/architecture/mainline-manifests');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const scripts = pkg.scripts ?? {};
const { failures: mapFailures, parsed } = validateMainlineCallMap(root);
const owners = loadFeatureOwners(root);

const failures = [...mapFailures];
if (!parsed) {
  console.error('[verify:architecture-mainline-manifest-sync] failed');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}

if (!fs.existsSync(manifestDir)) {
  console.error('[verify:architecture-mainline-manifest-sync] failed');
  console.error(`- manifest dir missing: docs/architecture/mainline-manifests`);
  console.error('- run `npm run render:mainline-manifests`');
  process.exit(1);
}

const chainsById = new Map();
for (const chain of parsed.chains ?? []) {
  if (chain?.chain_id) chainsById.set(chain.chain_id, chain);
}

for (const chain of parsed.chains ?? []) {
  const chainId = chain?.chain_id;
  if (!chainId) continue;
  const manifestPath = path.join('docs/architecture/mainline-manifests', `${chainId}.yml`);
  const abs = path.join(root, manifestPath);
  if (!fs.existsSync(abs)) {
    failures.push(`missing manifest for chain ${chainId}: ${manifestPath}`);
    continue;
  }
  let manifest;
  try {
    manifest = YAML.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    failures.push(`${manifestPath}: invalid YAML (${err.message})`);
    continue;
  }
  if (!manifest || typeof manifest !== 'object') {
    failures.push(`${manifestPath}: empty/non-object root`);
    continue;
  }
  if (manifest.lifecycle_id !== chainId) {
    failures.push(`${manifestPath}: lifecycle_id "${manifest.lifecycle_id}" != chain_id "${chainId}"`);
  }
  const ownerFeatureId = manifest.owner_feature_id;
  if (!ownerFeatureId || !owners.has(ownerFeatureId)) {
    failures.push(`${manifestPath}: owner_feature_id not in function-map: ${ownerFeatureId}`);
  }
  if (manifest.entrypoint?.call_map_chain_id !== chainId) {
    failures.push(`${manifestPath}: entrypoint.call_map_chain_id mismatch`);
  }
  if (manifest.entrypoint?.node_id !== chain.entry_contract?.node) {
    failures.push(`${manifestPath}: entrypoint.node_id != chain entry_contract.node`);
  }
  if (manifest.entrypoint?.wiki_page && manifest.entrypoint.wiki_page !== chain.entry_contract?.owner_doc) {
    failures.push(`${manifestPath}: entrypoint.wiki_page != chain entry_contract.owner_doc`);
  }
  const nodeIds = Array.isArray(manifest.node_ids) ? manifest.node_ids : [];
  const edges = Array.isArray(chain.edges) ? chain.edges : [];
  const chainNodeSet = new Set();
  for (const edge of edges) {
    if (typeof edge?.from_node === 'string') chainNodeSet.add(edge.from_node);
    if (typeof edge?.to_node === 'string') chainNodeSet.add(edge.to_node);
  }
  for (const nodeId of nodeIds) {
    if (!chainNodeSet.has(nodeId)) {
      failures.push(`${manifestPath}: node_id "${nodeId}" not in chain ${chainId} edges`);
    }
  }
  for (const nodeId of chainNodeSet) {
    if (!nodeIds.includes(nodeId)) {
      failures.push(`${manifestPath}: chain node "${nodeId}" missing from manifest.node_ids`);
    }
  }
  const stepIds = Array.isArray(manifest.step_ids) ? manifest.step_ids : [];
  const chainStepSet = new Set();
  for (const edge of edges) {
    if (typeof edge?.step_id === 'string') chainStepSet.add(edge.step_id);
  }
  for (const stepId of stepIds) {
    if (!chainStepSet.has(stepId)) {
      failures.push(`${manifestPath}: step_id "${stepId}" not in chain ${chainId} edges`);
    }
  }
  for (const stepId of chainStepSet) {
    if (!stepIds.includes(stepId)) {
      failures.push(`${manifestPath}: chain step "${stepId}" missing from manifest.step_ids`);
    }
  }
  const requiredGates = Array.isArray(manifest.verification?.required_gates) ? manifest.verification.required_gates : [];
  for (const gate of requiredGates) {
    const m = String(gate).match(/^npm run ([A-Za-z0-9:_-]+)$/);
    if (!m) {
      failures.push(`${manifestPath}: required gate must be npm run command: ${gate}`);
      continue;
    }
    if (!scripts[m[1]]) {
      failures.push(`${manifestPath}: required gate script missing in package.json: ${m[1]}`);
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:architecture-mainline-manifest-sync] failed');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}

console.log('[verify:architecture-mainline-manifest-sync] ok');
console.log(`- checked ${parsed.chains.length} mainline manifests`);
