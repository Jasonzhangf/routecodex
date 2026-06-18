import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const manifestPath = 'docs/architecture/metadata-center-manifest.yml';
const mainlinePath = 'docs/architecture/mainline-call-map.yml';
const functionMapPath = 'docs/architecture/function-map.yml';
const verificationMapPath = 'docs/architecture/verification-map.yml';
const packagePath = 'package.json';

function readText(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

function loadYaml(relPath) {
  return YAML.parse(readText(relPath));
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function listStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : [];
}

function packageScriptName(command) {
  const match = command.match(/^npm run ([A-Za-z0-9:_-]+)$/u);
  return match ? match[1] : '';
}

const failures = [];

const manifest = loadYaml(manifestPath);
const mainline = loadYaml(mainlinePath);
const functionMap = loadYaml(functionMapPath);
const verificationMap = loadYaml(verificationMapPath);
const pkg = JSON.parse(readText(packagePath));
const scripts = pkg.scripts ?? {};

const lifecycleId = asString(manifest?.lifecycle_id);
const ownerFeatureId = asString(manifest?.owner_feature_id);
const entrypoint = manifest?.entrypoint && typeof manifest.entrypoint === 'object'
  ? manifest.entrypoint
  : {};
const entryNode = asString(entrypoint.node_id);
const wikiPage = asString(entrypoint.wiki_page);
const callMapChainId = asString(entrypoint.call_map_chain_id);
const nodeIds = listStrings(manifest?.node_ids);

if (!lifecycleId) failures.push(`${manifestPath}: missing lifecycle_id`);
if (!ownerFeatureId) failures.push(`${manifestPath}: missing owner_feature_id`);
if (!entryNode) failures.push(`${manifestPath}: missing entrypoint.node_id`);
if (!wikiPage) failures.push(`${manifestPath}: missing entrypoint.wiki_page`);
if (!callMapChainId) failures.push(`${manifestPath}: missing entrypoint.call_map_chain_id`);
if (callMapChainId && lifecycleId && callMapChainId !== lifecycleId) {
  failures.push(`${manifestPath}: lifecycle_id and entrypoint.call_map_chain_id must match`);
}
if (nodeIds.length === 0) failures.push(`${manifestPath}: missing node_ids`);

const duplicateNodeIds = nodeIds.filter((nodeId, index) => nodeIds.indexOf(nodeId) !== index);
if (duplicateNodeIds.length > 0) {
  failures.push(`${manifestPath}: duplicate node_ids ${[...new Set(duplicateNodeIds)].join(', ')}`);
}
if (entryNode && !nodeIds.includes(entryNode)) {
  failures.push(`${manifestPath}: entrypoint.node_id is not listed in node_ids: ${entryNode}`);
}

const feature = (functionMap?.owners ?? []).find((row) => row?.feature_id === ownerFeatureId);
if (!feature) {
  failures.push(`${manifestPath}: owner_feature_id not found in function-map: ${ownerFeatureId}`);
} else {
  const canonicalTypes = new Set(listStrings(feature.canonical_types));
  for (const nodeId of nodeIds) {
    if (!canonicalTypes.has(nodeId)) {
      failures.push(`${functionMapPath}: feature ${ownerFeatureId} canonical_types missing manifest node_id ${nodeId}`);
    }
  }
}

const verification = (verificationMap?.verification ?? []).find((row) => row?.feature_id === ownerFeatureId);
if (!verification) {
  failures.push(`${manifestPath}: owner_feature_id not found in verification-map: ${ownerFeatureId}`);
}

const chain = (mainline?.chains ?? []).find((row) => row?.chain_id === callMapChainId);
if (!chain) {
  failures.push(`${manifestPath}: call_map_chain_id not found in mainline-call-map: ${callMapChainId}`);
} else {
  if (entryNode && chain?.entry_contract?.node !== entryNode) {
    failures.push(`${mainlinePath}: chain ${callMapChainId} entry_contract.node does not match manifest entrypoint.node_id`);
  }
  if (wikiPage && chain?.entry_contract?.owner_doc !== wikiPage) {
    failures.push(`${mainlinePath}: chain ${callMapChainId} entry_contract.owner_doc does not match manifest entrypoint.wiki_page`);
  }
  const chainNodes = new Set();
  for (const edge of chain.edges ?? []) {
    if (typeof edge?.from_node === 'string') chainNodes.add(edge.from_node);
    if (typeof edge?.to_node === 'string') chainNodes.add(edge.to_node);
    if (edge?.owner_feature_id !== ownerFeatureId) {
      failures.push(`${mainlinePath}: chain ${callMapChainId} edge ${edge?.step_id ?? '?'} owner_feature_id must be ${ownerFeatureId}`);
    }
  }
  for (const nodeId of nodeIds) {
    if (!chainNodes.has(nodeId)) {
      failures.push(`${mainlinePath}: chain ${callMapChainId} is missing manifest node_id ${nodeId}`);
    }
  }
  for (const nodeId of chainNodes) {
    if (!nodeIds.includes(nodeId)) {
      failures.push(`${manifestPath}: node_ids missing mainline chain node ${nodeId}`);
    }
  }
}

if (wikiPage && !fs.existsSync(path.join(root, wikiPage))) {
  failures.push(`${manifestPath}: missing wiki page ${wikiPage}`);
} else if (wikiPage) {
  const wiki = readText(wikiPage);
  for (const requiredToken of [lifecycleId, ownerFeatureId, manifestPath, ...nodeIds].filter(Boolean)) {
    if (!wiki.includes(requiredToken)) {
      failures.push(`${wikiPage}: missing manifest token ${requiredToken}`);
    }
  }
}

const requiredGates = listStrings(manifest?.verification?.required_gates);
if (requiredGates.length === 0) {
  failures.push(`${manifestPath}: missing verification.required_gates`);
}
for (const gate of requiredGates) {
  const script = packageScriptName(gate);
  if (!script) {
    failures.push(`${manifestPath}: required gate must be an npm script command: ${gate}`);
    continue;
  }
  if (!scripts[script]) {
    failures.push(`${manifestPath}: required gate script not found in package.json: ${script}`);
  }
}

if (failures.length > 0) {
  console.error('[verify:architecture-manifest-sync] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:architecture-manifest-sync] ok');
console.log(`- manifest: ${manifestPath}`);
console.log(`- lifecycle: ${lifecycleId}`);
console.log(`- nodes: ${nodeIds.length}`);
console.log(`- owner feature: ${ownerFeatureId}`);
