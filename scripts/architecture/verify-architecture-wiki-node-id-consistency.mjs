/**
 * verify-architecture-wiki-node-id-consistency
 *
 * Cross-checks wiki pages (generated + manual) against mainline-call-map.yml:
 * - Every from_node/to_node in each chain must appear in the corresponding wiki page.
 * - For metadata-center-mainline-source.md: node_ids must match metadata-center-manifest.yml.
 * Reports extra nodes in wiki (not in call map) as warnings; missing nodes as errors.
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

// Chain -> wiki page mapping (same as render-architecture-wiki-pages.mjs)
const CHAIN_WIKI_MAP = [
  { chainId: 'request.mainline', page: 'docs/architecture/wiki/request-mainline-call-graph.md' },
  { chainId: 'response.mainline', page: 'docs/architecture/wiki/response-mainline-call-graph.md' },
  { chainId: 'error.mainline', page: 'docs/architecture/wiki/error-mainline-call-graph.md' },
  { chainId: 'runtime.lifecycle.mainline', page: 'docs/architecture/wiki/runtime-lifecycle-call-graph.md' },
  { chainId: 'runtime.tmux_client_binding.mainline', page: 'docs/architecture/wiki/mainline-call-graph.md' },
  { chainId: 'stopless.session.mainline', page: 'docs/architecture/wiki/stopless-session-mainline-source.md' },
  { chainId: 'metadata.center.mainline', page: 'docs/architecture/wiki/metadata-center-mainline-source.md' },
];

const mainline = loadYaml(path.join(root, 'docs/architecture/mainline-call-map.yml'));
const mainlineChains = new Map((mainline?.chains ?? []).map(c => [c?.chain_id, c]));

// Build per-chain node set from call map edges
const chainNodesMap = new Map();
for (const [chainId, chain] of mainlineChains) {
  const nodes = new Set();
  for (const edge of (chain?.edges ?? [])) {
    if (edge?.from_node) nodes.add(edge.from_node);
    if (edge?.to_node) nodes.add(edge.to_node);
  }
  chainNodesMap.set(chainId, nodes);
}

// Also load metadata-center-manifest node_ids for dedicated check
let metadataManifestNodeIds = new Set();
try {
  const mcm = loadYaml(path.join(root, 'docs/architecture/metadata-center-manifest.yml'));
  if (Array.isArray(mcm?.node_ids)) metadataManifestNodeIds = new Set(mcm.node_ids);
} catch (_) {}

const failures = [];
const warnings = [];

for (const { chainId, page } of CHAIN_WIKI_MAP) {
  const absPage = path.join(root, page);
  if (!fs.existsSync(absPage)) {
    failures.push(`${page}: wiki page missing`);
    continue;
  }
  const wikiText = readAbs(absPage);

  // Extract node IDs from Mermaid blocks.
  // Patterns:
  //   NodeName["NodeName"]     in flowchart declarations
  //   class NodeName anchored/pending/partial
  const nodePattern = /\b([A-Z][A-Za-z0-9]+(?:[A-Z][a-z0-9]+)*)\["/g;
  const classPattern = /\bclass\s+([A-Z][A-Za-z0-9]+(?:[A-Z][a-z0-9]+)*)\s+(anchored|pending|partial|anchored;|pending;|partial;)/g;
  const wikiNodes = new Set();
  let m;
  while ((m = nodePattern.exec(wikiText)) !== null) wikiNodes.add(m[1]);
  while ((m = classPattern.exec(wikiText)) !== null) wikiNodes.add(m[1]);

  // Normalize: collapse variants like "anchored;" vs "anchored"
  // Remove class-style duplicates (already covered)
  // Remove classDef lines (they declare the class name only, not a node instance)
  const classDefPattern = /\bclassDef\s+(\w+)\s+/g;
  while ((m = classDefPattern.exec(wikiText)) !== null) wikiNodes.delete(m[1]);

  const callMapNodes = chainNodesMap.get(chainId) ?? new Set();

  // Missing: in call map but not in wiki (error)
  for (const node of callMapNodes) {
    if (!wikiNodes.has(node)) {
      failures.push(`${page}: node '${node}' from call map chain '${chainId}' missing in wiki`);
    }
  }

  // Extra: in wiki but not in call map (warning — may be intentional for diagrams)
  for (const node of wikiNodes) {
    if (!callMapNodes.has(node)) {
      // Check if it's a node that appears in another chain
      let foundElsewhere = false;
      for (const [otherChainId, otherNodes] of chainNodesMap) {
        if (otherChainId !== chainId && otherNodes.has(node)) {
          foundElsewhere = true;
          break;
        }
      }
      if (!foundElsewhere) {
        warnings.push(`${page}: wiki node '${node}' not found in call map chain '${chainId}'`);
      }
    }
  }

  // Special case: metadata.center.mainline also cross-check against manifest node_ids
  if (chainId === 'metadata.center.mainline' && metadataManifestNodeIds.size > 0) {
    const manifestExtra = [...metadataManifestNodeIds].filter(n => !callMapNodes.has(n));
    const wikiExtra = [...wikiNodes].filter(n => !callMapNodes.has(n) && !metadataManifestNodeIds.has(n));
    for (const nid of manifestExtra) {
      if (!wikiNodes.has(nid)) {
        failures.push(`${page}: manifest node '${nid}' missing in wiki`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:architecture-wiki-node-id-consistency] failed');
  for (const f of failures) console.error(`- ${f}`);
  if (warnings.length > 0) {
    console.error('warnings:');
    for (const w of warnings) console.error(`- ${w}`);
  }
  process.exit(1);
}

if (warnings.length > 0) {
  console.warn('[verify:architecture-wiki-node-id-consistency] ok with warnings');
  for (const w of warnings) console.warn(`- ${w}`);
} else {
  console.log('[verify:architecture-wiki-node-id-consistency] ok');
}
console.log(`- checked ${CHAIN_WIKI_MAP.length} wiki pages against mainline call map`);
