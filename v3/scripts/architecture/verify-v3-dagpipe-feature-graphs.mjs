#!/usr/bin/env node
// Governs the non-proxy feature DAG graphs that live in docs/architecture/dags/.
//
// The proxy pipeline's three object-source graphs live in docs/architecture/dagpipe/ and are
// governed by verify:v3-dagpipe-governance, whose modules.json is hard-scoped to
// v3-proxy-pipeline-target.md and to exactly [request, response, error]. Registering a
// control-plane graph there would falsely claim proxy-pipeline membership, so those graphs are
// kept out of that directory. They are still governed by the same `dagpipe graph validate`
// contract — this gate is what makes that governance real instead of a hand-run command in a
// plan document.
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const directory = resolve(root, 'docs/architecture/dags');

function fail(message) {
  console.error(`[v3-dagpipe-feature-graphs] FAIL ${message}`);
  process.exit(1);
}

if (!existsSync(directory)) {
  fail('missing docs/architecture/dags directory');
}

const graphs = readdirSync(directory)
  .filter((name) => name.endsWith('.graph.json'))
  .sort();

if (graphs.length === 0) {
  fail('no feature DAG graph found in docs/architecture/dags');
}

for (const name of graphs) {
  const graph = resolve(directory, name);
  const validated = spawnSync('dagpipe', ['graph', 'validate', graph], { encoding: 'utf8' });
  if (validated.error) {
    fail(`${name}: dagpipe CLI unavailable: ${validated.error.message}`);
  }
  if (validated.status !== 0) {
    fail(`${name}: ${(validated.stderr || validated.stdout || '').trim()}`);
  }
  const summary = (validated.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('valid DAG'));
  if (!summary) {
    fail(`${name}: dagpipe did not report a validated DAG`);
  }
  console.log(`[v3-dagpipe-feature-graphs] VALID ${name}: ${summary}`);
}

// Phase 2: cross-check every graph node's resource effect against the resource
// operation map. The operator string is a dotted path; the last segment is the
// symbol name (e.g. "build_environment", "PatrolRuntime::run_due"). A node that
// reads a resource id must name a symbol present in that resource's
// allowed_readers; a node that writes one must name a symbol in its
// allowed_writers. Without this check the graphs and the resource map can drift
// apart while each validates on its own, which is exactly the NB5 failure class.
const resourceMapPath = resolve(root, 'docs/architecture/v3-resource-operation-map.yml');
let resourceMap;
try {
  resourceMap = YAML.parse(readFileSync(resourceMapPath, 'utf8'));
} catch (error) {
  fail(`resource operation map YAML parse failed: ${error.message}`);
}
const resourcesById = new Map((resourceMap.resources ?? []).map((entry) => [entry.resource_id, entry]));
const mismatches = [];

function symbolOf(operator) {
  return String(operator).split('.').pop() ?? '';
}

function checkNode(name, node) {
  const operator = node?.operator;
  const symbol = symbolOf(operator);
  if (!operator) {
    mismatches.push(`${name}: node ${node?.id} has no operator`);
    return;
  }
  const resources = node?.resources ?? {};
  for (const resourceId of resources.reads ?? []) {
    const entry = resourcesById.get(resourceId);
    if (!entry) {
      mismatches.push(`${name}: node ${node?.id} reads unknown resource ${resourceId}`);
      continue;
    }
    const readers = entry.allowed_readers ?? [];
    if (!readers.includes(symbol)) {
      mismatches.push(`${name}: node ${node?.id} operator ${symbol} reads ${resourceId} but it is not in allowed_readers [${readers.join(', ')}]`);
    }
  }
  for (const resourceId of resources.writes ?? []) {
    const entry = resourcesById.get(resourceId);
    if (!entry) {
      mismatches.push(`${name}: node ${node?.id} writes unknown resource ${resourceId}`);
      continue;
    }
    const writers = entry.allowed_writers ?? [];
    if (!writers.includes(symbol)) {
      mismatches.push(`${name}: node ${node?.id} operator ${symbol} writes ${resourceId} but it is not in allowed_writers [${writers.join(', ')}]`);
    }
  }
}

for (const name of graphs) {
  let graph;
  try {
    graph = JSON.parse(readFileSync(resolve(directory, name), 'utf8'));
  } catch (error) {
    fail(`${name}: graph JSON parse failed: ${error.message}`);
  }
  for (const node of graph?.nodes ?? []) {
    checkNode(name, node);
  }
}

if (mismatches.length > 0) {
  console.error('[v3-dagpipe-feature-graphs] FAIL resource-effect mismatches:');
  for (const mismatch of mismatches) console.error(`- ${mismatch}`);
  process.exit(1);
}

console.log(`[v3-dagpipe-feature-graphs] governed ${graphs.length} feature graph(s)`);
