import fs from 'node:fs';
import path from 'node:path';
import {
  MAINLINE_CALL_MAP_PATH,
  MAINLINE_WIKI_PATH,
  validateMainlineCallMap,
} from './mainline-call-map-lib.mjs';

const root = process.cwd();
const { failures: mapFailures, parsed } = validateMainlineCallMap(root);
const failures = [...mapFailures];

if (!parsed) {
  console.error('[verify:architecture-mainline-node-id-consistency] failed');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}

const wikiPath = MAINLINE_WIKI_PATH;
const wikiAbs = path.join(root, wikiPath);
if (!fs.existsSync(wikiAbs)) {
  console.error('[verify:architecture-mainline-node-id-consistency] failed');
  console.error(`- wiki index page missing: ${wikiPath}`);
  process.exit(1);
}
const wikiText = fs.readFileSync(wikiAbs, 'utf8');

function extractChainSection(fullText, chainId) {
  const startToken = `## ${chainId}`;
  const start = fullText.indexOf(startToken);
  if (start === -1) return '';
  const rest = fullText.slice(start + startToken.length);
  const nextHeader = rest.search(/\n##\s+/);
  return nextHeader === -1 ? rest : rest.slice(0, nextHeader + 1);
}

// Wiki-side declaration set is sourced ONLY from Mermaid node declarations
// (`NodeId["..."]`). class/table rows are informative views but do not count
// as declaration truth because they can mask a renamed declaration.
function collectSectionNodes(sectionText) {
  const nodes = new Set();
  for (const m of sectionText.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)\["[^\]]*"\]/gm)) nodes.add(m[1]);
  return nodes;
}

function collectSectionClassNodes(sectionText) {
  const nodes = new Set();
  for (const m of sectionText.matchAll(/^\s*class\s+([A-Za-z][A-Za-z0-9]*)\s+\w+\s*;?/gm)) nodes.add(m[1]);
  return nodes;
}

function collectSectionSteps(sectionText) {
  // Steps are sourced ONLY from Mermaid edge labels (`X -->|step| Y`) and the
  // markdown edge table.
  const steps = new Set();
  for (const m of sectionText.matchAll(/[A-Za-z][A-Za-z0-9]*\s+-{1,2}>\|([^|]+)\|\s+[A-Za-z][A-Za-z0-9]*/g)) {
    steps.add(m[1].trim());
  }
  for (const m of sectionText.matchAll(/^\|\s*([a-z]+-\d+(?:-[a-z]+)?)\s*\|/gm)) {
    steps.add(m[1]);
  }
  return steps;
}

for (const chain of parsed.chains ?? []) {
  const chainId = chain?.chain_id ?? '?';
  const section = extractChainSection(wikiText, chainId);
  if (!section) {
    failures.push(`${wikiPath}: missing section for chain ${chainId}`);
    continue;
  }
  const wikiNodes = collectSectionNodes(section);
  const wikiClassNodes = collectSectionClassNodes(section);
  const wikiSteps = collectSectionSteps(section);
  const callMapNodes = new Set();
  const callMapSteps = new Set();
  for (const edge of chain.edges ?? []) {
    if (typeof edge?.from_node === 'string') callMapNodes.add(edge.from_node);
    if (typeof edge?.to_node === 'string') callMapNodes.add(edge.to_node);
    if (typeof edge?.step_id === 'string') callMapSteps.add(edge.step_id);
  }
  for (const nodeId of callMapNodes) {
    if (!wikiNodes.has(nodeId)) {
      failures.push(`${MAINLINE_CALL_MAP_PATH}: chain ${chainId} node "${nodeId}" not declared in wiki section ${chainId}`);
    }
  }
  for (const nodeId of wikiClassNodes) {
    if (['anchored', 'partial', 'pending'].includes(nodeId)) continue;
    if (!callMapNodes.has(nodeId)) {
      failures.push(`${wikiPath}: chain ${chainId} wiki class node "${nodeId}" not in mainline-call-map section ${chainId}`);
    }
  }
  for (const stepId of callMapSteps) {
    if (!wikiSteps.has(stepId)) {
      failures.push(`${MAINLINE_CALL_MAP_PATH}: chain ${chainId} step "${stepId}" not in wiki section ${chainId}`);
    }
  }
  for (const stepId of wikiSteps) {
    if (!callMapSteps.has(stepId)) {
      failures.push(`${wikiPath}: chain ${chainId} wiki step "${stepId}" not in mainline-call-map section ${chainId}`);
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:architecture-mainline-node-id-consistency] failed');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}

console.log('[verify:architecture-mainline-node-id-consistency] ok');
console.log(`- checked ${parsed.chains.length} chains against chain-local wiki declaration sections`);
