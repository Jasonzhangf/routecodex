#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const v3Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(v3Root, '..');
const ownerFeatureId = 'architecture.repository_filesystem_governance';
const contractMapPaths = [
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-verification-map.yml',
];
const failures = [];

function readYaml(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    failures.push(`${relativePath}: missing`);
    return {};
  }
  return YAML.parse(fs.readFileSync(absolutePath, 'utf8')) ?? {};
}

function readText(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    failures.push(`${relativePath}: missing`);
    return '';
  }
  return fs.readFileSync(absolutePath, 'utf8');
}

function assertUniqueRegistryOwner(registry) {
  const modules = Array.isArray(registry.modules) ? registry.modules : [];
  const owner = modules.find((module) => module?.module_id === ownerFeatureId);
  if (!owner) {
    failures.push(`registry: missing ${ownerFeatureId} owner`);
    return;
  }
  for (const contractMapPath of contractMapPaths) {
    if (!owner.owned_paths?.includes(contractMapPath)) {
      failures.push(`registry: ${ownerFeatureId} must own ${contractMapPath}`);
    }
    const otherModules = modules.filter((module) => module !== owner && (
      module?.owned_paths?.includes(contractMapPath)
      || module?.allowed_paths?.includes(contractMapPath)
    ));
    if (otherModules.length > 0) {
      failures.push(`registry: ${contractMapPath} has another module binding: ${otherModules.map((module) => module.module_id).join(', ')}`);
    }
  }
  for (const gate of [
    'npm run verify:v3-contract-map-owner',
    'npm run verify:v3-resource-map',
    'npm run verify:v3-direct-sse-accept-skeleton',
    'npm run verify:sse-architecture-boundary',
    'npm run verify:v3-architecture-ci',
  ]) {
    if (!owner.required_gates?.includes(gate)) failures.push(`registry: ${ownerFeatureId} missing gate ${gate}`);
  }
}

function assertCanonicalFeatureBindings(functionMap, resourceMap, mainlineMap, verificationMap) {
  const functionOwner = functionMap.owners?.find((owner) => owner?.feature_id === ownerFeatureId);
  if (!functionOwner) failures.push(`function map: missing ${ownerFeatureId}`);
  for (const contractMapPath of contractMapPaths) {
    if (!functionOwner?.allowed_paths?.includes(contractMapPath)) {
      failures.push(`function map: ${ownerFeatureId} missing ${contractMapPath}`);
    }
  }
  if (!functionOwner?.required_gates?.includes('npm run verify:v3-contract-map-owner')) {
    failures.push(`function map: ${ownerFeatureId} missing contract-map gate`);
  }
  const resource = resourceMap.resources?.find((entry) => entry?.resource_id === 'architecture.v3_contract_map_set');
  if (!resource || resource.owner_feature_id !== ownerFeatureId) {
    failures.push('resource map: architecture.v3_contract_map_set must bind to the filesystem owner');
  }
  const chain = mainlineMap.chains?.find((entry) => entry?.chain_id === 'architecture.v3_contract_maps.mainline');
  const edge = chain?.edges?.find((entry) => entry?.step_id === 'architecture-v3-contract-map-01');
  if (!edge || edge.owner_feature_id !== ownerFeatureId) {
    failures.push('mainline map: contract-map verification edge is missing or has the wrong owner');
  }
  const verification = verificationMap.verification?.find((entry) => entry?.feature_id === ownerFeatureId);
  if (!verification?.smoke?.includes('npm run verify:v3-contract-map-owner')) {
    failures.push(`verification map: ${ownerFeatureId} missing contract-map smoke gate`);
  }
}

function assertGateSource() {
  const source = readText('v3/scripts/architecture/verify-v3-contract-map-owner.mjs');
  const architectureCi = readText('v3/scripts/architecture/verify-v3-architecture-ci.mjs');
  for (const symbol of ['function assertUniqueRegistryOwner', 'function assertCanonicalFeatureBindings']) {
    if (!source.includes(symbol)) failures.push(`gate source: missing ${symbol}`);
  }
  if (!architectureCi.includes("'verify:v3-contract-map-owner'")) {
    failures.push('architecture CI: verify:v3-contract-map-owner is not wired into the V3 umbrella');
  }
}

export function verifyV3ContractMapOwner() {
  const registry = readYaml('docs/architecture/repository-filesystem-module-registry.yml');
  const functionMap = readYaml('docs/architecture/function-map.yml');
  const resourceMap = readYaml('docs/architecture/resource-operation-map.yml');
  const mainlineMap = readYaml('docs/architecture/mainline-call-map.yml');
  const verificationMap = readYaml('docs/architecture/verification-map.yml');
  assertUniqueRegistryOwner(registry);
  assertCanonicalFeatureBindings(functionMap, resourceMap, mainlineMap, verificationMap);
  assertGateSource();
  return failures;
}

const result = verifyV3ContractMapOwner();
if (result.length > 0) {
  console.error('[verify:v3-contract-map-owner] failed');
  for (const failure of result) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-contract-map-owner] ok');
