#!/usr/bin/env node
// Architecture gate for routecodex-v4-runtime-inspector.
// Positive: snapshot projects only management state; the inspector has no
// mutation API and never reads business payload.
// Red: payload/control/secret/native-handle fields in projection fail.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const source = fs.readFileSync(
  path.join(root, 'crates/routecodex-v4-runtime-inspector/src/lib.rs'),
  'utf8',
);
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
const forbidden = red
  ? ['pub payload', 'pub metadata_center', 'pub secret', 'pub native_handle']
  : ['fn mutate', 'fn write', 'fn publish'];
for (const token of forbidden) {
  if (source.includes(token)) failures.push(`forbidden: ${token}`);
}
if (failures.length > 0) {
  console.error(`v4_parity_gate_runtime_inspector ${red ? 'red' : 'positive'} FAIL`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`v4_parity_gate_runtime_inspector ${red ? 'red' : 'positive'} OK`);
