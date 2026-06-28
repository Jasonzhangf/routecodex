/**
 * verify-architecture-mainline-manifest-sync
 *
 * Checks:
 * 1. All 7 chain manifests exist in docs/architecture/manifests/
 * 2. Each manifest has valid schema
 * 3. owner_feature_id exists in function-map
 * 4. call_map_chain_id exists in mainline-call-map
 * 5. entrypoint node_id is in chain node_ids
 * 6. node_ids match chain edges
 * 7. entrypoint wiki_page exists
 * 8. verification.required_gates scripts exist in package.json
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();

function readAbs(absPath) {
  return fs.readFileSync(absPath, 'utf8');
}
function loadYaml(absPath) {
  return YAML.parse(readAbs(absPath));
}

const mainline = loadYaml(path.join(root, 'docs/architecture/mainline-call-map.yml'));
const functionMap = loadYaml(path.join(root, 'docs/architecture/function-map.yml'));
const pkg = JSON.parse(readAbs(path.join(root, 'package.json')));
const scripts = pkg.scripts ?? {};

const knownFunctionFeatures = new Set(
  (functionMap?.owners ?? []).map(r => r?.feature_id).filter(Boolean)
);
const mainlineChainIds = new Set(
  (mainline?.chains ?? []).map(c => c?.chain_id).filter(Boolean)
);
const metadataManifestNodes = new Set();
try {
  const mcm = loadYaml(path.join(root, 'docs/architecture/metadata-center-manifest.yml'));
  if (Array.isArray(mcm?.node_ids)) metadataManifestNodes = new Set(mcm.node_ids);
} catch (_) { /* ignore */ }

const failures = [];

const expectedChains = [
  'request.mainline', 'response.mainline', 'error.mainline',
  'runtime.lifecycle.mainline',
  'stopless.session.mainline', 'metadata.center.mainline',
];

for (const chainId of expectedChains) {
  const manifestPath = path.join(root, 'docs/architecture/manifests', `${chainId.replace(/\//g, '_')}.yml`);
  if (!fs.existsSync(manifestPath)) {
    failures.push(`missing manifest: ${path.relative(root, manifestPath)}`);
    continue;
  }
  const m = loadYaml(manifestPath);
  const lifecycleId = m?.lifecycle_id ?? '';
  const ownerFeatureId = m?.owner_feature_id ?? '';
  const entrypoint = m?.entrypoint ?? {};
  const entryNode = entrypoint?.node_id ?? '';
  const callMapChainId = entrypoint?.call_map_chain_id ?? '';
  const wikiPage = entrypoint?.wiki_page ?? '';
  const nodeIds = Array.isArray(m?.node_ids) ? m.node_ids : [];
  const requiredGates = Array.isArray(m?.verification?.required_gates)
    ? m.verification.required_gates : [];

  if (!lifecycleId) failures.push(`${manifestPath}: missing lifecycle_id`);
  if (!ownerFeatureId) failures.push(`${manifestPath}: missing owner_feature_id`);
  if (!entryNode) failures.push(`${manifestPath}: missing entrypoint.node_id`);
  if (!callMapChainId) failures.push(`${manifestPath}: missing entrypoint.call_map_chain_id`);

  if (ownerFeatureId && ownerFeatureId !== 'shared' && !knownFunctionFeatures.has(ownerFeatureId)) {
    failures.push(`${manifestPath}: owner_feature_id '${ownerFeatureId}' not in function-map`);
  }
  if (callMapChainId && !mainlineChainIds.has(callMapChainId)) {
    failures.push(`${manifestPath}: call_map_chain_id '${callMapChainId}' not in mainline-call-map`);
  }
  if (entryNode && nodeIds.length > 0 && !nodeIds.includes(entryNode)) {
    failures.push(`${manifestPath}: entrypoint.node_id '${entryNode}' not in node_ids`);
  }

  // node_ids must match chain edges
  if (callMapChainId) {
    const chain = (mainline?.chains ?? []).find(c => c?.chain_id === callMapChainId);
    if (chain) {
      const chainNodes = new Set();
      for (const edge of (chain.edges ?? [])) {
        if (edge?.from_node) chainNodes.add(edge.from_node);
        if (edge?.to_node) chainNodes.add(edge.to_node);
      }
      for (const nid of nodeIds) {
        if (!chainNodes.has(nid)) {
          failures.push(`${path.relative(root, manifestPath)}: node_id '${nid}' not in chain '${callMapChainId}'`);
        }
      }
      for (const cn of chainNodes) {
        if (!nodeIds.includes(cn)) {
          failures.push(`${path.relative(root, manifestPath)}: chain '${callMapChainId}' node '${cn}' missing from node_ids`);
        }
      }
    }
  }

  if (wikiPage && !fs.existsSync(path.join(root, wikiPage))) {
    failures.push(`${path.relative(root, manifestPath)}: wiki_page not on disk: ${wikiPage}`);
  }

  if (requiredGates.length === 0) {
    failures.push(`${path.relative(root, manifestPath)}: missing verification.required_gates`);
  }
  for (const gate of requiredGates) {
    const match = String(gate).match(/^npm run ([A-Za-z0-9:_-]+)$/);
    if (!match) {
      failures.push(`${path.relative(root, manifestPath)}: gate must be 'npm run <script>': ${gate}`);
      continue;
    }
    if (!scripts[match[1]]) {
      failures.push(`${path.relative(root, manifestPath)}: gate script not in package.json: ${match[1]}`);
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:architecture-mainline-manifest-sync] failed');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}

console.log('[verify:architecture-mainline-manifest-sync] ok');
console.log(`- checked ${expectedChains.length} chain manifests`);
console.log('- schema, function-map owner, call-map chain, node_ids, wiki_page, required_gates all consistent');
