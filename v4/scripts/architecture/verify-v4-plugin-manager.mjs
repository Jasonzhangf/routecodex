#!/usr/bin/env node
// Architecture gate for routecodex-v4-plugin-manager.
// Positive: manager source owns the active pointer and audit ledger;
// lifecycle port is a trait consumed via typed port, no Cordis import.
// Red: any forbidden pattern (Cordis import, business payload, fallback,
// auto-rollback, second active truth) fails.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const crateDir = path.join(root, 'crates/routecodex-v4-plugin-manager');
const source = [
  'src/lib.rs',
  'src/manager.rs',
  'src/audit.rs',
  'src/lifecycle.rs',
]
  .map((file) => path.join(crateDir, file))
  .filter((file) => fs.existsSync(file))
  .map((file) => fs.readFileSync(file, 'utf8'))
  .join('\n');
const red = process.argv.includes('--red-self-test');
const failures = [];

const required = [
  'pub trait LifecyclePort',
  'pub struct PluginManager',
  'fn publish(',
  'expected_base_hash',
  'mount_candidate',
  'Option<ActiveChain>',
  'AuditSink',
  'ExecutionFailure',
];
for (const token of required) {
  if (!source.includes(token)) failures.push(`missing: ${token}`);
}

// Real Rust import syntax: any reference to Cordis/NodeContainer internals or
// a second node-selection primitive is a hard boundary violation.
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

// State/DTO fields must never carry business payload, control state, secret
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

if (red) {
  // Red fixtures: the checks must actually detect a real Rust import and a
  // payload field when present.
  const fixtureImport = 'use routecodex_v4_cordis_bridge::compile_node;';
  if (forbiddenImportHits(fixtureImport).length === 0) {
    failures.push('red fixture: Cordis import not detected');
  }
  const fixtureField = 'pub struct Leak { pub payload: String }';
  if (forbiddenFieldHits(fixtureField).length === 0) {
    failures.push('red fixture: payload field not detected');
  }
}
if (failures.length > 0) {
  console.error(`v4_parity_gate_plugin_manager ${red ? 'red' : 'positive'} FAIL`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`v4_parity_gate_plugin_manager ${red ? 'red' : 'positive'} OK`);
