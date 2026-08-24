#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const v3Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = process.env.ROUTECODEX_V3_SOURCE_ROOT
  ? path.resolve(process.env.ROUTECODEX_V3_SOURCE_ROOT)
  : path.resolve(v3Root, '..');
const architectureRoot = path.join(sourceRoot, 'docs', 'architecture');
const failures = [];

function readYaml(relativePath) {
  const absolutePath = path.join(sourceRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    failures.push(`${relativePath}: missing`);
    return {};
  }
  try {
    return YAML.parse(fs.readFileSync(absolutePath, 'utf8')) ?? {};
  } catch (error) {
    failures.push(`${relativePath}: YAML parse failed: ${error.message}`);
    return {};
  }
}

const v3Mainline = readYaml('docs/architecture/v3-mainline-call-map.yml');
const genericMainline = readYaml('docs/architecture/mainline-call-map.yml');
const v3FunctionMap = readYaml('docs/architecture/v3-function-map.yml');
const genericFunctionMap = readYaml('docs/architecture/function-map.yml');
const manifestDir = path.join(architectureRoot, 'manifests');

const chains = new Set();
for (const entry of [...(v3Mainline?.chains ?? []), ...(genericMainline?.chains ?? [])]) {
  if (entry.chain_id) chains.add(entry.chain_id);
}
const featureIds = new Set([
  ...(v3FunctionMap?.features ?? []).map((feature) => feature.feature_id),
  ...(genericFunctionMap?.owners ?? []).map((owner) => owner.feature_id),
]);

if (!fs.existsSync(manifestDir)) {
  failures.push(`docs/architecture/manifests: missing`);
} else {
  for (const file of fs.readdirSync(manifestDir).sort()) {
    if (!file.startsWith('architecture.') || !file.endsWith('.mainline.yml')) continue;
    const manifestPath = path.join(manifestDir, file);
    let manifest;
    try {
      manifest = YAML.parse(fs.readFileSync(manifestPath, 'utf8')) ?? {};
    } catch (error) {
      failures.push(`${manifestPath}: YAML parse failed: ${error.message}`);
      continue;
    }
    const chainId = manifest.chain_id ?? manifest.lifecycle_id ?? manifest.entrypoint?.call_map_chain_id;
    if (!chainId) {
      failures.push(`${manifestPath}: missing chain_id/lifecycle_id/call_map_chain_id`);
      continue;
    }
    if (!chains.has(chainId)) failures.push(`${manifestPath}: chain id ${chainId} not found in call maps`);
    const owner = manifest.owner_feature_id;
    if (owner && !featureIds.has(owner)) {
      failures.push(`${manifestPath}: owner_feature_id ${owner} not found in canonical function maps`);
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:v3-mainline-manifest-sync] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-mainline-manifest-sync] ok');
