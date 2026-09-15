import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  MAINLINE_CALL_MAP_PATH,
  FUNCTION_MAP_PATH,
  validateMainlineCallMap,
  loadFeatureOwners,
} from './mainline-call-map-lib.mjs';

const root = process.cwd();
const outDir = path.join(root, 'docs/architecture/mainline-manifests');
fs.mkdirSync(outDir, { recursive: true });

const { failures, parsed } = validateMainlineCallMap(root);
if (failures.length > 0 || !parsed) {
  console.error('[render:mainline-manifests] failed');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}

const owners = loadFeatureOwners(root);
let written = 0;

for (const chain of parsed.chains ?? []) {
  const chainId = chain?.chain_id;
  if (!chainId) continue;
  const edges = Array.isArray(chain.edges) ? chain.edges : [];
  if (edges.length === 0) continue;

  const ownerFeatureId = edges[0].owner_feature_id ?? 'binding pending';
  const entryNode = chain.entry_contract?.node ?? '';
  const wikiPage = chain.entry_contract?.owner_doc ?? '';
  const nodeIds = new Set();
  for (const edge of edges) {
    if (typeof edge?.from_node === 'string') nodeIds.add(edge.from_node);
    if (typeof edge?.to_node === 'string') nodeIds.add(edge.to_node);
  }
  const stepIds = edges
    .map((edge) => (typeof edge?.step_id === 'string' ? edge.step_id : ''))
    .filter(Boolean);
  const anchoredCount = edges.filter((e) => (e?.status ?? '') === 'anchored').length;
  const partialCount = edges.filter((e) => (e?.status ?? '') === 'partial').length;
  const pendingCount = edges.filter((e) => e?.binding_pending === true).length;

  const ownerMeta = owners.get(ownerFeatureId) ?? {};
  const manifest = {
    lifecycle_id: chainId,
    summary: chain.summary ?? '',
    owner_feature_id: ownerFeatureId,
    owner_module: ownerMeta.ownerModule ?? '',
    entrypoint: {
      node_id: entryNode,
      wiki_page: wikiPage,
      call_map_chain_id: chainId,
    },
    node_ids: [...nodeIds].sort(),
    step_ids: stepIds,
    edge_status_counts: {
      anchored: anchoredCount,
      partial: partialCount,
      binding_pending: pendingCount,
      total: edges.length,
    },
    sources: {
      mainline_call_map: MAINLINE_CALL_MAP_PATH,
      function_map: FUNCTION_MAP_PATH,
    },
    verification: {
      min_call_map_chain: chainId,
      min_function_feature: ownerFeatureId,
      required_gates: [
        'npm run verify:architecture-mainline-call-map',
        'npm run verify:architecture-mainline-node-id-consistency',
      ],
    },
  };

  const outFile = path.join(outDir, `${chainId}.yml`);
  fs.writeFileSync(outFile, YAML.stringify(manifest, { lineWidth: 0 }), 'utf8');
  written += 1;
}

console.log('[render:mainline-manifests] ok');
console.log(`- wrote ${written} manifests under docs/architecture/mainline-manifests/`);
