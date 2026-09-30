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
const expected = ['request', 'response', 'error'];
if (!Array.isArray(manifest.modules) || manifest.modules.length !== expected.length ||
    manifest.modules.some((entry, index) => entry.id !== expected[index])) fail('modules must be request, response, error in order');

const registered = new Set();
for (const entry of manifest.modules) {
  if (entry.status === 'pending' && entry.graph === null) {
    console.log(`[v3-dagpipe] PENDING ${entry.id}`);
    continue;
  }
  if (entry.status !== 'graph' || typeof entry.graph !== 'string') fail(`invalid status/graph for ${entry.id}`);
  const graph = projectFile(entry.graph);
  if (dirname(graph) !== directory || !graph.endsWith('.graph.json')) fail(`graph must be in DAGPipe directory: ${entry.graph}`);
  if (registered.has(graph)) fail(`graph shared by modules: ${entry.graph}`);
  registered.add(graph);
  const result = spawnSync('dagpipe', ['graph', 'validate', graph], { encoding: 'utf8' });
  if (result.error || result.status !== 0) fail(`${entry.id} graph validation: ${result.error?.message || result.stderr || result.stdout}`);
  console.log(`[v3-dagpipe] VALID ${entry.id}: ${entry.graph}`);
}
for (const slice of manifest.derived_slices ?? []) {
  if (!expected.includes(slice.parent) || !slice.id?.startsWith(`${slice.parent}.`)) fail(`invalid derived slice parent/id: ${slice.id}`);
  const graph = projectFile(slice.graph);
  if (dirname(graph) !== directory || !graph.endsWith('.graph.json')) fail(`derived slice graph must be in DAGPipe directory: ${slice.graph}`);
  if (registered.has(graph)) fail(`graph shared by modules or slices: ${slice.graph}`);
  const parsed = JSON.parse(readFileSync(graph, 'utf8'));
  if (parsed.id !== `v3.operation_runner.${slice.id}`) fail(`derived slice graph id mismatch: ${slice.id}`);
  registered.add(graph);
  const result = spawnSync('dagpipe', ['graph', 'validate', graph], { encoding: 'utf8' });
  if (result.error || result.status !== 0) fail(`${slice.id} graph validation: ${result.error?.message || result.stderr || result.stdout}`);
  console.log(`[v3-dagpipe] VALID slice ${slice.id}: ${slice.graph}`);
}
for (const name of readdirSync(directory)) {
  if (name.endsWith('.graph.json') && !registered.has(resolve(directory, name))) fail(`unregistered graph: ${name}`);
}
console.log(`[v3-dagpipe] governance checked; ${expected.length} modules and ${(manifest.derived_slices ?? []).length} derived slices registered`);
