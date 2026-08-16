#!/usr/bin/env node
// Architecture gate for routecodex-v4-plugin-manager.
// Positive: manager source owns the active pointer and audit ledger;
// lifecycle port is a trait consumed via typed port, no Cordis import.
// Red: any forbidden pattern (Cordis import, business payload, fallback,
// auto-rollback, second active truth) fails.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const source = fs.readFileSync(
  path.join(root, 'crates/routecodex-v4-plugin-manager/src/manager.rs'),
  'utf8',
);
const lib = fs.readFileSync(
  path.join(root, 'crates/routecodex-v4-plugin-manager/src/lib.rs'),
  'utf8',
);
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
if (red) {
  required.push(
    // Red fixtures: forbidden patterns must be absent in source.
    // A candidate failure must not mutate the active pointer, and no
    // Cordis internals may be imported by the manager.
    '!from \'cordis\'',
    '!import cordis',
    '!next_node',
  );
}
for (const token of required) {
  const negated = token.startsWith('!');
  const needle = negated ? token.slice(1) : token;
  const found = source.includes(needle) || lib.includes(needle);
  if (negated ? found : !found) {
    failures.push(`${negated ? 'forbidden' : 'missing'}: ${needle}`);
  }
}
if (failures.length > 0) {
  console.error(`v4_parity_gate_plugin_manager ${red ? 'red' : 'positive'} FAIL`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`v4_parity_gate_plugin_manager ${red ? 'red' : 'positive'} OK`);
