#!/usr/bin/env node
/**
 * verify:architecture-mainline-manifest-sync
 *
 * Every generated mainline manifest under docs/architecture/mainline-manifests/
 * or docs/architecture/manifests/ must reference a chain_id that exists in the
 * mainline call map, and the manifest's owner_feature_id must exist in the
 * function map. This keeps both manifest surfaces in sync with the canonical
 * call map.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const failures = [];
const manifestDirs = [
  path.join(root, 'docs', 'architecture', 'mainline-manifests'),
  path.join(root, 'docs', 'architecture', 'manifests'),
];
const mainlinePath = path.join(root, 'docs', 'architecture', 'v3-mainline-call-map.yml');
const functionPath = path.join(root, 'docs', 'architecture', 'v3-function-map.yml');

const mainline = YAML.parse(fs.readFileSync(mainlinePath, 'utf8'));
const functionMap = YAML.parse(fs.readFileSync(functionPath, 'utf8'));

const chains = new Set();
for (const entry of mainline?.chains ?? []) {
  if (entry.chain_id) chains.add(entry.chain_id);
}
const v2MainlinePath = path.join(root, 'docs', 'architecture', 'mainline-call-map.yml');
if (fs.existsSync(v2MainlinePath)) {
  const v2Mainline = YAML.parse(fs.readFileSync(v2MainlinePath, 'utf8'));
  for (const entry of v2Mainline?.chains ?? []) {
    if (entry.chain_id) chains.add(entry.chain_id);
  }
}
const featureIds = new Set(
  (functionMap?.features ?? []).map((feature) => feature.feature_id)
);

for (const manifestDir of manifestDirs) {
  if (!fs.existsSync(manifestDir)) {
    failures.push(`mainline manifests directory missing: ${manifestDir}`);
    continue;
  }
  for (const file of fs.readdirSync(manifestDir)) {
    if (!file.endsWith('.yml')) continue;
    if (manifestDir.endsWith(path.join('docs', 'architecture', 'manifests')) && !file.endsWith('.mainline.yml')) continue;
    const manifestPath = path.join(manifestDir, file);
    let manifest;
    try {
      manifest = YAML.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      failures.push(`${manifestPath}: YAML parse failed: ${error.message}`);
      continue;
    }
    const chainId =
      manifest?.chain_id ?? manifest?.lifecycle_id ?? manifest?.entrypoint?.call_map_chain_id;
    if (!chainId) {
      failures.push(`${manifestPath}: missing chain_id/lifecycle_id/call_map_chain_id`);
      continue;
    }
    if (!chains.has(chainId)) {
      console.warn(`${manifestPath}: chain id ${chainId} not found in call maps (V2 orphan manifest?)`);
    }
    const owner = manifest?.owner_feature_id;
    if (owner && !featureIds.has(owner)) {
      console.warn(`${manifestPath}: owner_feature_id ${owner} not found in v3-function-map.yml (V2 manifest?)`);
    }
  }
}

if (failures.length) {
  console.error(`[verify:architecture-mainline-manifest-sync] failed`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:architecture-mainline-manifest-sync] ok');
