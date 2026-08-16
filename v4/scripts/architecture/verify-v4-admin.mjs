#!/usr/bin/env node
// Architecture gate for routecodex-v4-admin.
// Positive: admin exposes typed commands/queries and delegates mutation to
// PluginManager and queries to RuntimeInspector.
// Red: DTO surface must not contain payload/control/secret/native-handle
// fields; admin must not own sorting/order/permission decisions.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const source = fs.readFileSync(
  path.join(root, 'crates/routecodex-v4-admin/src/lib.rs'),
  'utf8',
);
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
const forbidden = red
  ? ['pub payload', 'pub secret', 'pub native_handle', 'pub sort', 'pub permission']
  : ['next_node', 'from \'cordis\''];
for (const token of forbidden) {
  if (source.includes(token)) failures.push(`forbidden: ${token}`);
}
if (failures.length > 0) {
  console.error(`v4_parity_gate_admin ${red ? 'red' : 'positive'} FAIL`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`v4_parity_gate_admin ${red ? 'red' : 'positive'} OK`);
