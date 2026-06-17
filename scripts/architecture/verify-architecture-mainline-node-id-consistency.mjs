import fs from 'node:fs';
import path from 'node:path';
import {
  GENERATED_WIKI_CHAIN_PAGES,
  MAINLINE_CALL_MAP_PATH,
  MAINLINE_WIKI_PATH,
  validateMainlineCallMap,
} from './mainline-call-map-lib.mjs';

const root = process.cwd();
const { failures: mapFailures, parsed } = validateMainlineCallMap(root);
const failures = [...mapFailures];

if (!parsed) {
  console.error('[verify:architecture-mainline-node-id-consistency] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

function getChainWikiPath(chainId) {
  return GENERATED_WIKI_CHAIN_PAGES.find((entry) => entry.chainId === chainId)?.path ?? MAINLINE_WIKI_PATH;
}

function extractChainSection(markdown, chainId, relPath) {
  if (relPath !== MAINLINE_WIKI_PATH) return markdown;
  const heading = `## ${chainId}`;
  const start = markdown.indexOf(heading);
  if (start === -1) {
    failures.push(`${relPath}: missing section heading ${heading}`);
    return '';
  }
  const nextHeading = markdown.indexOf('\n## ', start + heading.length);
  return nextHeading === -1 ? markdown.slice(start) : markdown.slice(start, nextHeading);
}

function collectNodesAndSteps(markdown) {
  const nodes = new Set(
    [...markdown.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)\["[^\]]*"\]/gm)].map((m) => m[1])
  );
  for (const match of markdown.matchAll(/^\s*class\s+([A-Za-z][A-Za-z0-9]*)\s+\w+\s*;?/gm)) {
    nodes.add(match[1]);
  }

  const steps = new Set();
  for (const match of markdown.matchAll(/[A-Za-z][A-Za-z0-9]*\s+-{1,2}>\|([^|]+)\|\s+[A-Za-z][A-Za-z0-9]*/g)) {
    steps.add(match[1].trim());
  }
  for (const match of markdown.matchAll(/^\|\s*([a-z]+(?:-[a-z0-9]+)+)\s*\|/gm)) {
    steps.add(match[1]);
  }

  return { nodes, steps };
}

for (const chain of parsed.chains ?? []) {
  const chainId = chain?.chain_id ?? '?';
  const wikiPath = getChainWikiPath(chainId);
  const wikiAbs = path.join(root, wikiPath);
  if (!fs.existsSync(wikiAbs)) {
    failures.push(`${chainId}: wiki page missing: ${wikiPath}`);
    continue;
  }

  const wikiText = extractChainSection(fs.readFileSync(wikiAbs, 'utf8'), chainId, wikiPath);
  const { nodes: wikiNodes, steps: wikiSteps } = collectNodesAndSteps(wikiText);
  const callMapNodes = new Set();
  const callMapSteps = new Set();

  for (const edge of chain.edges ?? []) {
    if (typeof edge?.from_node === 'string') callMapNodes.add(edge.from_node);
    if (typeof edge?.to_node === 'string') callMapNodes.add(edge.to_node);
    if (typeof edge?.step_id === 'string') callMapSteps.add(edge.step_id);
  }

  for (const nodeId of callMapNodes) {
    if (!wikiNodes.has(nodeId)) {
      failures.push(`${MAINLINE_CALL_MAP_PATH}: chain ${chainId} node "${nodeId}" not in wiki ${wikiPath}`);
    }
  }
  for (const stepId of callMapSteps) {
    if (!wikiSteps.has(stepId)) {
      failures.push(`${MAINLINE_CALL_MAP_PATH}: chain ${chainId} step "${stepId}" not in wiki ${wikiPath}`);
    }
  }

  for (const nodeId of wikiNodes) {
    if (['anchored', 'partial', 'pending'].includes(nodeId)) continue;
    if (!callMapNodes.has(nodeId)) {
      failures.push(`${wikiPath}: chain ${chainId} wiki node "${nodeId}" not declared in mainline-call-map`);
    }
  }
  for (const stepId of wikiSteps) {
    if (!callMapSteps.has(stepId)) {
      failures.push(`${wikiPath}: chain ${chainId} wiki step "${stepId}" not declared in mainline-call-map`);
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:architecture-mainline-node-id-consistency] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:architecture-mainline-node-id-consistency] ok');
console.log(`- checked ${parsed.chains.length} chains against chain-local wiki pages/sections`);
