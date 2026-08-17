#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const sourcePath = path.join(root, 'crates/routecodex-v4-node-container/src/lib.rs');
const required = [
  'pub struct NodeContainer',
  'pub fn fail',
  'PlanBindings',
  'execute_plan',
  'NodeContainerState',
  'loaded_plan_hash != plan.hash',
];
const forbidden = ['struct Context', 'struct Fiber', 'struct Effect', 'serde_json::Value'];

function validate(source) {
  const failures = required.filter((token) => !source.includes(token));
  if (forbidden.some((token) => source.includes(token))) {
    failures.push('Rust node-container contains a Cordis-like runtime or generic payload');
  }
  return failures;
}

function runSelfTest() {
  const baseline = fs.readFileSync(sourcePath, 'utf8');
  const cases = [
    ['synthetic Cordis runtime', (source) => `${source}\nstruct Context;`],
    ['plan binding guard removed', (source) => source.replace('loaded_plan_hash != plan.hash', 'false')],
    ['failed-state transition removed', (source) => source.replace('pub fn fail', 'fn fail')],
  ];
  let missed = 0;
  for (const [name, mutate] of cases) {
    const failures = validate(mutate(baseline));
    if (failures.length === 0) {
      console.error(`[v4 node container red] ${name}: expected FAIL, got PASS`);
      missed += 1;
    } else {
      console.log(`[v4 node container red] ${name}: FAIL as expected (${failures.length})`);
    }
  }
  if (missed > 0) process.exit(1);
  console.log('[v4 node container red] OK red self-test 3/3');
}

if (process.argv.includes('--red-self-test')) {
  runSelfTest();
  process.exit(0);
}

const failures = validate(fs.readFileSync(sourcePath, 'utf8'));
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('[v4 node container] OK typed lifecycle state machine and plan binding');
