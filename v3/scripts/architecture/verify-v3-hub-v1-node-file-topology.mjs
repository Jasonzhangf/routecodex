#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = process.env.ROUTECODEX_V3_SOURCE_ROOT
  ? path.resolve(process.env.ROUTECODEX_V3_SOURCE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const failures = [];

const FUNCTION_MAP = 'docs/architecture/v3-function-map.yml';
const MAINLINE_MAP = 'docs/architecture/v3-mainline-call-map.yml';
const HUB_SOURCE_DIR = 'v3/crates/routecodex-v3-runtime/src/hub_v1';
const HUB_TEST_DIR = 'v3/crates/routecodex-v3-runtime/tests';

function rel(file) {
  return file.split(path.sep).join('/');
}

function abs(file) {
  return path.join(root, file);
}

function fail(message) {
  failures.push(message);
}

function read(file) {
  try {
    return fs.readFileSync(abs(file), 'utf8');
  } catch (error) {
    fail(`${file}: cannot read: ${error.message}`);
    return '';
  }
}

function parseYaml(file) {
  try {
    return YAML.parse(read(file));
  } catch (error) {
    fail(`${file}: YAML parse failed: ${error.message}`);
    return {};
  }
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rustFiles(dir) {
  const out = [];
  if (!fs.existsSync(abs(dir))) return out;
  for (const entry of fs.readdirSync(abs(dir))) {
    const file = path.join(dir, entry);
    const stat = fs.statSync(abs(file));
    if (stat.isDirectory()) {
      out.push(...rustFiles(file));
    } else if (stat.isFile() && file.endsWith('.rs')) {
      out.push(rel(file));
    }
  }
  return out.sort();
}

const functionMap = parseYaml(FUNCTION_MAP);
const mainlineMap = parseYaml(MAINLINE_MAP);
const h1Function = array(functionMap.features).find((entry) => entry?.feature_id === 'v3.hub_pipeline_static_skeleton');

if (!h1Function) {
  fail(`${FUNCTION_MAP}: missing feature v3.hub_pipeline_static_skeleton`);
}

const rootFile = h1Function?.module_export_owner_file;
if (!rootFile) {
  fail(`${FUNCTION_MAP}: H1 module_export_owner_file missing`);
}

const nodeOwners = array(h1Function?.node_owner_files)
  .map((entry) => ({
    node: entry?.node,
    ownerFile: entry?.owner_file,
    builderSymbol: entry?.builder_symbol,
  }))
  .filter((owner) => owner.node);
if (!nodeOwners.length) fail(`${FUNCTION_MAP}: H1 node_owner_files missing`);

const sharedHelpers = array(h1Function?.shared_helper_owner_files).map((entry) => entry?.file).filter(Boolean);
const sourceFiles = [
  rootFile,
  ...rustFiles(HUB_SOURCE_DIR),
  ...rustFiles(HUB_TEST_DIR),
].filter(Boolean).filter((file, index, arr) => arr.indexOf(file) === index);

function typeDefinitionPattern(symbol) {
  return new RegExp(
    `(?:^|\\n)\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:struct|enum|type)\\s+${escapeRegExp(symbol)}\\b`,
    'm',
  );
}

function fnDefinitionPattern(symbol) {
  return new RegExp(
    `(?:^|\\n)\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${escapeRegExp(symbol)}\\b`,
    'm',
  );
}

function filesMatching(pattern) {
  return sourceFiles.filter((file) => fs.existsSync(abs(file)) && pattern.test(read(file)));
}

function typeDefinitionFiles(symbol) {
  return filesMatching(typeDefinitionPattern(symbol));
}

function fnDefinitionFiles(symbol) {
  return filesMatching(fnDefinitionPattern(symbol));
}

function symbolDefinitionFiles(symbol) {
  const raw = String(symbol ?? '');
  const base = raw.split('::')[0];
  if (!base) return [];
  if (raw.includes('::')) return typeDefinitionFiles(base);
  const fnDefs = fnDefinitionFiles(base);
  return fnDefs.length ? fnDefs : typeDefinitionFiles(base);
}

function checkFileExists(file) {
  if (!fs.existsSync(abs(file))) fail(`${file}: missing`);
}

for (const owner of nodeOwners) {
  if (!owner.ownerFile || !owner.builderSymbol) {
    fail(`${FUNCTION_MAP}: incomplete H1 node owner declaration ${JSON.stringify(owner)}`);
    continue;
  }
  checkFileExists(owner.ownerFile);
  const nodeDefs = typeDefinitionFiles(owner.node);
  if (nodeDefs.length !== 1 || nodeDefs[0] !== owner.ownerFile) {
    fail(`${owner.node}: expected one definition in ${owner.ownerFile}, got ${nodeDefs.join(', ') || 'none'}`);
  }
  const builderDefs = fnDefinitionFiles(owner.builderSymbol);
  if (builderDefs.length !== 1 || builderDefs[0] !== owner.ownerFile) {
    fail(`${owner.builderSymbol}: expected one definition in ${owner.ownerFile}, got ${builderDefs.join(', ') || 'none'}`);
  }
}

for (const helper of sharedHelpers) {
  checkFileExists(helper);
  const text = read(helper);
  for (const owner of nodeOwners) {
    if (typeDefinitionPattern(owner.node).test(text)) {
      fail(`${helper}: shared helper must not define node ${owner.node}`);
    }
    if (fnDefinitionPattern(owner.builderSymbol).test(text)) {
      fail(`${helper}: shared helper must not define builder ${owner.builderSymbol}`);
    }
  }
}

if (rootFile) {
  const rootSource = read(rootFile);
  for (const [index, line] of rootSource.split('\n').entries()) {
    if (/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum)\s+\w+|^\s*(?:pub(?:\([^)]*\))?\s+)?impl(?:<[^>]*>)?\s+/.test(line)) {
      fail(`${rootFile}:${index + 1}: root aggregator must stay declaration/reexport-only`);
    }
  }
}

const declaredNodes = new Set(nodeOwners.map((owner) => owner.node));
const ownerByBuilder = new Map(nodeOwners.map((owner) => [owner.builderSymbol, owner]));
const allEdges = array(mainlineMap.chains).flatMap((chain) => array(chain.edges));
const h1Edges = array(mainlineMap.chains)
  .filter((chain) => chain?.owner_feature_id === 'v3.hub_pipeline_static_skeleton')
  .flatMap((chain) => array(chain.edges));
const nodesWithMainlineEdge = new Set();

for (const edge of allEdges) {
  for (const kind of ['caller', 'callee']) {
    const symbol = edge?.[`${kind}_symbol`];
    const file = edge?.[`${kind}_file`];
    if (!symbol || !file) continue;
    if (!String(file).startsWith(HUB_SOURCE_DIR) && !String(file).startsWith(`${HUB_TEST_DIR}/`)) continue;
    if (rootFile && file === rootFile) {
      fail(`${MAINLINE_MAP}: ${edge.step_id} ${kind}_file points to root aggregator for ${symbol}`);
      continue;
    }
    const defs = symbolDefinitionFiles(symbol);
    if (defs.length === 1 && defs[0] !== file) {
      fail(`${MAINLINE_MAP}: ${edge.step_id} ${kind}_file ${file} does not match ${symbol} definition ${defs[0]}`);
    } else if (defs.length > 1) {
      if (ownerByBuilder.has(symbol)) {
        fail(`${MAINLINE_MAP}: ${edge.step_id} ${kind}_symbol ${symbol} has duplicate definitions: ${defs.join(', ')}`);
      } else if (!defs.includes(file)) {
        fail(`${MAINLINE_MAP}: ${edge.step_id} ${kind}_file ${file} is not one of ${symbol} definitions: ${defs.join(', ')}`);
      }
    } else if (defs.length === 0 && String(file).startsWith(HUB_SOURCE_DIR)) {
      fail(`${MAINLINE_MAP}: ${edge.step_id} ${kind}_symbol ${symbol} has no definition in Hub v1 sources/tests`);
    }
  }
}

for (const edge of h1Edges) {
  const endpointNodes = [edge?.from_node, edge?.to_node].filter(Boolean);
  if (endpointNodes.some((node) => declaredNodes.has(node)) && endpointNodes.some((node) => !declaredNodes.has(node))) {
    fail(`${MAINLINE_MAP}: ${edge.step_id} mixes declared Hub v1 node with undeclared node: ${endpointNodes.join(' -> ')}`);
  }
  if (endpointNodes.length === 2 && endpointNodes.every((node) => declaredNodes.has(node))) {
    nodesWithMainlineEdge.add(edge.from_node);
    nodesWithMainlineEdge.add(edge.to_node);
  }
}

for (const node of declaredNodes) {
  if (!nodesWithMainlineEdge.has(node)) fail(`${MAINLINE_MAP}: declared Hub v1 node ${node} has no mainline edge`);
}

if (failures.length) {
  console.error('[verify:v3-hub-v1-node-file-topology] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:v3-hub-v1-node-file-topology] ok');
console.log(`- contract nodes: ${declaredNodes.size}`);
console.log(`- shared helpers: ${sharedHelpers.length}`);
