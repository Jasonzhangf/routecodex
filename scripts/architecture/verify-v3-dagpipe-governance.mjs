#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = resolve(root, 'docs/architecture/dagpipe');
const manifestPath = resolve(root, process.argv[2] || 'docs/architecture/dagpipe/modules.json');

function fail(message) {
  console.error(`[v3-dagpipe] FAIL ${message}`);
  process.exit(1);
}

function projectFile(value) {
  if (typeof value !== 'string' || !value || isAbsolute(value)) fail(`invalid project path: ${value}`);
  const absolute = resolve(root, value);
  if (relative(root, absolute).startsWith('..') || !existsSync(absolute)) fail(`missing or escaped project path: ${value}`);
  return absolute;
}

let manifest;
try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
catch (error) { fail(`cannot read manifest: ${error.message}`); }
if (manifest.target !== 'docs/architecture/dagpipe/v3-proxy-pipeline-target.md') fail('target must be the V3 proxy pipeline design');
projectFile(manifest.target);
const required = ['request', 'response', 'error'];
if (!Array.isArray(manifest.modules) || manifest.modules.length < required.length ||
    required.some((id, index) => manifest.modules[index]?.id !== id)) fail('modules must start with request, response, error in order');

const registered = new Set();
for (const entry of manifest.modules) {
  if (entry.status === 'pending' && entry.graph === null) {
    console.log(`[v3-dagpipe] PENDING ${entry.id}`);
    continue;
  }
  if (entry.status !== 'graph' || typeof entry.graph !== 'string') fail(`invalid status/graph for ${entry.id}`);
  const graph = projectFile(entry.graph);
  const relativeGraph = relative(directory, graph);
  if (relativeGraph.startsWith('..') || isAbsolute(relativeGraph) || !graph.endsWith('.graph.json')) fail(`graph must be in DAGPipe directory: ${entry.graph}`);
  if (registered.has(graph)) fail(`graph shared by modules: ${entry.graph}`);
  registered.add(graph);
  const result = spawnSync('dagpipe', ['graph', 'validate', graph], { encoding: 'utf8' });
  if (result.error || result.status !== 0) fail(`${entry.id} graph validation: ${result.error?.message || result.stderr || result.stdout}`);
  console.log(`[v3-dagpipe] VALID ${entry.id}: ${entry.graph}`);
}
const extensions = Array.isArray(manifest.extensions) ? manifest.extensions : [];
for (const entry of extensions) {
  if (!entry.id || !entry.status) fail(`extension entry must declare id/status`);
  if (entry.status === 'pending' && entry.graph === null) {
    console.log(`[v3-dagpipe] PENDING ${entry.id}`);
    continue;
  }
  if (entry.status !== 'graph' || typeof entry.graph !== 'string') fail(`invalid status/graph for ${entry.id}`);
  const graph = projectFile(entry.graph);
  const relativeGraph = relative(directory, graph);
  if (relativeGraph.startsWith('..') || isAbsolute(relativeGraph) || !graph.endsWith('.graph.json')) fail(`graph must be in DAGPipe directory: ${entry.graph}`);
  if (registered.has(graph)) fail(`graph shared by modules: ${entry.graph}`);
  registered.add(graph);
  const result = spawnSync('dagpipe', ['graph', 'validate', graph], { encoding: 'utf8' });
  if (result.error || result.status !== 0) fail(`${entry.id} graph validation: ${result.error?.message || result.stderr || result.stdout}`);
  console.log(`[v3-dagpipe] VALID ${entry.id}: ${entry.graph}`);
}
function listGraphFiles(rootDir) {
  const files = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const full = resolve(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listGraphFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.graph.json')) {
      files.push(full);
    }
  }
  return files;
}

for (const graphFile of listGraphFiles(directory)) {
  if (!registered.has(graphFile)) fail(`unregistered graph: ${relative(directory, graphFile)}`);
}
console.log(`[v3-dagpipe] governance checked; ${registered.size} static graphs registered (${manifest.modules.length} modules, ${extensions.length} extensions)`);
