#!/usr/bin/env node
// Architecture gate for routecodex-v4-admin.
// Positive: admin exposes typed commands/queries and delegates mutation to
// PluginManager and queries to RuntimeInspector.
// Red: DTO surface must not contain payload/control/secret/native-handle
// fields; admin must not own sorting/order/permission decisions.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const crateDir = path.join(root, 'crates/routecodex-v4-admin');
const source = ['src/lib.rs']
  .map((file) => path.join(crateDir, file))
  .filter((file) => fs.existsSync(file))
  .map((file) => fs.readFileSync(file, 'utf8'))
  .join('\n');
const red = process.argv.includes('--red-self-test');
const failures = [];
const required = [
  'pub enum AdminCommand',
  'pub enum AdminQuery',
  'pub enum AdminResponse',
  'pub fn execute',
  'pub fn query',
  'AdminError',
];
for (const token of required) {
  if (!source.includes(token)) failures.push(`missing: ${token}`);
}

// Admin must never import Cordis/NodeContainer internals.
const FORBIDDEN_IMPORT_PATTERNS = [
  /use\s+routecodex_v4_cordis_bridge(?:\s*::|\s*;)/,
  /use\s+routecodex_v4_node_container(?:\s*::|\s*;)/,
  /\bcordis\s*::/,
  /\bnext_node\b/,
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

// DTO fields must never carry business payload, control state, secret
// material, or native handles; admin owns no sort/permission decisions.
const FORBIDDEN_FIELDS = new Set([
  'payload',
  'metadata_center',
  'secret',
  'native_handle',
  'token',
  'credential',
  'api_key',
  'sort',
  'permission',
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

if (red) {
  const fixtureImport = 'use routecodex_v4_cordis_bridge::execute_plan;';
  if (forbiddenImportHits(fixtureImport).length === 0) {
    failures.push('red fixture: Cordis import not detected');
  }
  const fixtureField = 'pub struct Leak { pub payload: String }';
  if (forbiddenFieldHits(fixtureField).length === 0) {
    failures.push('red fixture: payload field not detected');
  }
}
if (failures.length > 0) {
  console.error(`v4_parity_gate_admin ${red ? 'red' : 'positive'} FAIL`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`v4_parity_gate_admin ${red ? 'red' : 'positive'} OK`);
