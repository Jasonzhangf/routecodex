#!/usr/bin/env node
// Architecture gate for routecodex-v4-runtime-inspector.
// Positive: snapshot projects only management state; the inspector has no
// mutation API and never reads business payload.
// Red: payload/control/secret/native-handle fields in projection fail.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const crateDir = path.join(root, 'crates/routecodex-v4-runtime-inspector');
const source = ['src/lib.rs']
  .map((file) => path.join(crateDir, file))
  .filter((file) => fs.existsSync(file))
  .map((file) => fs.readFileSync(file, 'utf8'))
  .join('\n');
const red = process.argv.includes('--red-self-test');
const failures = [];
const required = [
  'pub struct RuntimeSnapshot',
  'pub fn snapshot',
  'active_pointer_kind',
  'container_lifecycle',
  'failed',
  'audit',
];
for (const token of required) {
  if (!source.includes(token)) failures.push(`missing: ${token}`);
}

// The inspector must never import Cordis/NodeContainer internals.
const FORBIDDEN_IMPORT_PATTERNS = [
  /use\s+routecodex_v4_cordis_bridge(?:\s*::|\s*;)/,
  /use\s+routecodex_v4_node_container(?:\s*::|\s*;)/,
  /\bcordis\s*::/,
];
function forbiddenImportHits(text) {
  return FORBIDDEN_IMPORT_PATTERNS.filter((pattern) => pattern.test(text)).map(
    (pattern) => String(pattern),
  );
}
const importHits = forbiddenImportHits(source);
if (importHits.length > 0) {
  failures.push(`forbidden import: ${importHits.join(', ')}`);
}

// Projection fields must never carry business payload, control state, secret
// material, or native handles.
const FORBIDDEN_FIELDS = new Set([
  'payload',
  'metadata_center',
  'secret',
  'native_handle',
  'token',
  'credential',
  'api_key',
]);
const FIELD_RE = /pub\s+([a-z_][a-z0-9_]*)\s*:/g;
function forbiddenFieldHits(text) {
  const hits = [];
  for (const match of text.matchAll(FIELD_RE)) {
    if (FORBIDDEN_FIELDS.has(match[1])) hits.push(match[1]);
  }
  return hits;
}
const fieldHits = forbiddenFieldHits(source);
if (fieldHits.length > 0) {
  failures.push(`forbidden field: ${fieldHits.join(', ')}`);
}

// The inspector exposes no mutation entrypoint.
for (const token of ['fn mutate', 'fn write', 'fn publish']) {
  if (source.includes(token)) failures.push(`forbidden mutation entrypoint: ${token}`);
}

if (red) {
  const fixtureImport = 'use routecodex_v4_node_container::NodeHandle;';
  if (forbiddenImportHits(fixtureImport).length === 0) {
    failures.push('red fixture: NodeContainer import not detected');
  }
  const fixtureField = 'pub struct Leak { pub payload: String }';
  if (forbiddenFieldHits(fixtureField).length === 0) {
    failures.push('red fixture: payload field not detected');
  }
}
if (failures.length > 0) {
  console.error(`v4_parity_gate_runtime_inspector ${red ? 'red' : 'positive'} FAIL`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`v4_parity_gate_runtime_inspector ${red ? 'red' : 'positive'} OK`);
