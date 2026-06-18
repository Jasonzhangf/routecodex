#!/usr/bin/env node
/**
 * Generate per-chain machine-readable manifests from mainline-call-map.yml.
 * Writes docs/architecture/manifests/<chain_id>.yml for each chain.
 *
 * Schema per manifest:
 *   lifecycle_id:        <chain_id>
 *   summary:            <chain.summary>
 *   owner_feature_id:   <dominant owner across edges, or "shared" if split>
 *   entrypoint:
 *     node_id:          <from_node of first edge>
 *     wiki_page:        <derived: docs/architecture/wiki/<chain_id>-chain.md or chain's wiki page>
 *     call_map_chain_id: <chain_id>
 *   node_ids:           <sorted unique from_node + to_node>
 *   edges:
 *     - step_id
 *       from_node
 *       to_node
 *       status
 *       owner_feature_id
 *       binding_pending / split_binding_id (if present)
 *   verification:
 *     required_gates:
 *       - npm run verify:architecture-mainline-call-map
 *       - npm run verify:architecture-mainline-manifest-sync
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const mainlinePath = path.join(root, 'docs/architecture/mainline-call-map.yml');
const outDir = path.join(root, 'docs/architecture/manifests');

const mainline = YAML.parse(fs.readFileSync(mainlinePath, 'utf8'));

fs.mkdirSync(outDir, { recursive: true });

const chainToWikiPage = {
  'request.mainline':           'docs/architecture/wiki/mainline-call-graph.md',
  'response.mainline':          'docs/architecture/wiki/response-mainline-call-graph.md',
  'error.mainline':             'docs/architecture/wiki/error-mainline-call-graph.md',
  'runtime.lifecycle.mainline':  'docs/architecture/wiki/runtime-lifecycle-call-graph.md',
  'runtime.tmux_client_binding.mainline': 'docs/architecture/wiki/stopless-session-mainline-source.md',
  'stopless.session.mainline':  'docs/architecture/wiki/stopless-session-mainline-source.md',
  'metadata.center.mainline':   'docs/architecture/wiki/metadata-center-mainline-source.md',
};

let written = 0;
for (const chain of (mainline?.chains ?? [])) {
  const chainId = chain?.chain_id ?? '';
  if (!chainId) continue;

  const nodeSet = new Set();
  const edges = [];
  const ownerCounts = {};

  for (const edge of (chain.edges ?? [])) {
    if (edge?.from_node) nodeSet.add(edge.from_node);
    if (edge?.to_node) nodeSet.add(edge.to_node);
    const ow = edge?.owner_feature_id ?? '';
    if (ow) ownerCounts[ow] = (ownerCounts[ow] ?? 0) + 1;
    edges.push({
      step_id: edge?.step_id ?? '',
      from_node: edge?.from_node ?? '',
      to_node: edge?.to_node ?? '',
      status: edge?.binding_pending === true ? 'binding pending' : (edge?.status ?? 'anchored'),
      owner_feature_id: ow || null,
      binding_pending: edge?.binding_pending === true ? true : null,
      split_binding_id: edge?.split_binding_id ?? null,
    });
  }

  // dominant owner
  const dominantOwner = Object.entries(ownerCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'shared';

  const nodeIds = [...nodeSet].sort();
  const firstEdge = chain.edges?.[0];
  const entryNode = firstEdge?.from_node ?? '';

  const manifest = {
    lifecycle_id: chainId,
    summary: typeof chain.summary === 'string' ? chain.summary : '',
    owner_feature_id: dominantOwner,
    entrypoint: {
      node_id: entryNode,
      wiki_page: chainToWikiPage[chainId] ?? null,
      call_map_chain_id: chainId,
    },
    node_ids: nodeIds,
    edges: edges.filter(e => e.step_id),
    verification: {
      required_gates: [
        'npm run verify:architecture-mainline-call-map',
        'npm run verify:architecture-mainline-manifest-sync',
      ],
    },
  };

  // strip nulls
  const manifestClean = JSON.parse(JSON.stringify(manifest));

  const outPath = path.join(outDir, `${chainId.replace(/\//g, '_')}.yml`);
  fs.writeFileSync(outPath, YAML.stringify(manifestClean), 'utf8');
  console.log(`[generate-mainline-chain-manifests] wrote ${outPath}`);
  written++;
}

console.log(`[generate-mainline-chain-manifests] ok - ${written} manifests written`);
