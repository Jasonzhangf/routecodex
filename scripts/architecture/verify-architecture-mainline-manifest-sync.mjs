/**
 * verify-architecture-mainline-manifest-sync
 *
 * Checks:
 * 1. Core chain manifests and mirrored active V3 lifecycle manifests exist
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
const v3Mainline = loadYaml(path.join(root, 'docs/architecture/v3-mainline-call-map.yml'));
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
  'internal_error_numbering.mainline',
  'runtime.lifecycle.mainline',
  'stopless.session.mainline', 'metadata.center.mainline',
];
const mirroredV3Chains = [
  'v3.console_request_count_visibility.mainline',
  'v3.runtime_timing_observability.mainline',
];
const manifestResourceFlowChains = new Set([
  'v3.runtime_timing_observability.mainline',
]);

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

for (const chainId of mirroredV3Chains) {
  const manifestPath = path.join(root, 'docs/architecture/manifests', `${chainId}.yml`);
  if (!fs.existsSync(manifestPath)) {
    failures.push(`missing manifest: ${path.relative(root, manifestPath)}`);
    continue;
  }
  const manifest = loadYaml(manifestPath);
  const globalChain = (mainline?.chains ?? []).find(chain => chain?.chain_id === chainId);
  const v3Chain = (v3Mainline?.chains ?? []).find(chain => chain?.chain_id === chainId);
  if (!globalChain) {
    failures.push(`docs/architecture/mainline-call-map.yml: missing mirrored V3 chain '${chainId}'`);
    continue;
  }
  if (!v3Chain) {
    failures.push(`docs/architecture/v3-mainline-call-map.yml: missing mirrored V3 chain '${chainId}'`);
    continue;
  }
  if (manifest?.entrypoint?.call_map_chain_id !== chainId) {
    failures.push(`${path.relative(root, manifestPath)}: call_map_chain_id must equal '${chainId}'`);
  }
  const manifestEdges = Array.isArray(manifest?.edges) ? manifest.edges : [];
  const globalEdges = Array.isArray(globalChain?.edges) ? globalChain.edges : [];
  const v3Edges = Array.isArray(v3Chain?.edges) ? v3Chain.edges : [];
  const edgeBinding = edge => [
    edge?.step_id,
    edge?.from_node,
    edge?.to_node,
    edge?.caller_symbol,
    edge?.caller_file,
    edge?.callee_symbol,
    edge?.callee_file,
    edge?.owner_feature_id,
  ];
  const manifestTopology = edge => [
    edge?.step_id,
    edge?.from_node,
    edge?.to_node,
    edge?.owner_feature_id,
  ];
  if (JSON.stringify(globalEdges.map(edgeBinding)) !== JSON.stringify(v3Edges.map(edgeBinding))) {
    failures.push(`${chainId}: global and V3 mainline callable bindings differ`);
  }
  const resourceFlowBinding = edge => [
    edge?.step_id,
    edge?.resource_flow?.consumes ?? [],
    edge?.resource_flow?.produces ?? [],
    edge?.resource_flow?.side_channel_reads ?? [],
    edge?.resource_flow?.side_channel_writes ?? [],
  ];
  if (
    JSON.stringify(globalEdges.map(resourceFlowBinding)) !==
    JSON.stringify(v3Edges.map(resourceFlowBinding))
  ) {
    failures.push(`${chainId}: global and V3 mainline resource flows differ`);
  }
  if (
    manifestResourceFlowChains.has(chainId) &&
    JSON.stringify(globalEdges.map(resourceFlowBinding)) !==
      JSON.stringify(manifestEdges.map(resourceFlowBinding))
  ) {
    failures.push(`${chainId}: global mainline resource flows differ from lifecycle manifest`);
  }
  if (
    manifestResourceFlowChains.has(chainId) &&
    JSON.stringify(v3Edges.map(resourceFlowBinding)) !==
      JSON.stringify(manifestEdges.map(resourceFlowBinding))
  ) {
    failures.push(`${chainId}: V3 mainline resource flows differ from lifecycle manifest`);
  }
  if (
    JSON.stringify(globalEdges.map(manifestTopology)) !==
    JSON.stringify(manifestEdges.map(manifestTopology))
  ) {
    failures.push(`${chainId}: global mainline topology differs from lifecycle manifest`);
  }
  if (
    JSON.stringify(v3Edges.map(manifestTopology)) !==
    JSON.stringify(manifestEdges.map(manifestTopology))
  ) {
    failures.push(`${chainId}: V3 mainline topology differs from lifecycle manifest`);
  }
}

if (failures.length > 0) {
  console.error('[verify:architecture-mainline-manifest-sync] failed');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}

console.log('[verify:architecture-mainline-manifest-sync] ok');
console.log(`- checked ${expectedChains.length + mirroredV3Chains.length} chain manifests`);
console.log('- schema, function-map owner, global/V3 call-map bindings, node_ids, wiki_page, required_gates all consistent');
