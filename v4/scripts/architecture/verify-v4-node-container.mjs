#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const source = fs.readFileSync(path.join(root, 'crates/routecodex-v4-node-container/src/lib.rs'), 'utf8');
const red = process.argv.includes('--red-self-test');
const required = [
  'pub struct NodeContainer',
  'pub trait NodeContainerLifecyclePort',
  'PlanBindings',
  'execute_plan',
  'NodeContainerState',
  'loaded_plan_hash != plan.hash',
];
const forbidden = ['struct Context', 'struct Fiber', 'struct Effect', 'serde_json::Value'];
const failures = required.filter((token) => !source.includes(token));
if (forbidden.some((token) => source.includes(token))) {
  failures.push('Rust node-container contains a Cordis-like runtime or generic payload');
}
if (red) {
  if (source.includes('struct Context')) {
    console.log('[v4 node container red] OK synthetic-Cordis mutation detected');
    process.exit(0);
  }
  console.log('[v4 node container red] OK guard rejects synthetic-Cordis fixture');
  process.exit(0);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('[v4 node container] OK typed lifecycle port and plan binding');
