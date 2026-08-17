#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const sourcePath = path.join(root, 'cordis/routecodex-v4-cordis-host/src/index.mjs');
const testsPath = path.join(root, 'cordis/routecodex-v4-cordis-host/tests/host.test.mjs');
const required = [
  'from \'cordis\'',
  'new Context()',
  'FiberState.ACTIVE',
  '.isolate(',
  'fiber.dispose()',
  'plugin_not_active',
  'mounted.push({ id: plugin.id, fiber });\n        await fiber.await();',
];
const forbidden = ['JSON.parse', 'metadata', 'fallback', 'next_node'];

function validate(source, tests) {
  const failures = required.filter((token) => !source.includes(token));
  if (forbidden.some((token) => source.includes(token))) {
    failures.push('Cordis host contains forbidden synthetic/control pattern');
  }
  if (
    !tests.includes('Context.is(host.context)')
    || !tests.includes('reverse order')
    || !tests.includes('failing in-flight fiber is disposed before mount rejects')
  ) {
    failures.push('black-box lifecycle tests missing');
  }
  return failures;
}

function runSelfTest() {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const tests = fs.readFileSync(testsPath, 'utf8');
  const cases = [
    ['real Cordis import removed', (candidate) => candidate.replace("from 'cordis'", "from 'fake-cordis'")],
    ['real Context removed', (candidate) => candidate.replace('new Context()', 'new FakeContext()')],
    ['failed Fiber tracking moved after await', (candidate) => candidate.replace(
      'mounted.push({ id: plugin.id, fiber });\n        await fiber.await();',
      'await fiber.await();\n        mounted.push({ id: plugin.id, fiber });',
    )],
  ];
  let missed = 0;
  for (const [name, mutate] of cases) {
    const failures = validate(mutate(source), tests);
    if (failures.length === 0) {
      console.error(`[v4 cordis host red] ${name}: expected FAIL, got PASS`);
      missed += 1;
    } else {
      console.log(`[v4 cordis host red] ${name}: FAIL as expected (${failures.length})`);
    }
  }
  if (missed > 0) process.exit(1);
  console.log('[v4 cordis host red] OK red self-test 3/3');
}

if (process.argv.includes('--red-self-test')) {
  runSelfTest();
  process.exit(0);
}

const failures = validate(
  fs.readFileSync(sourcePath, 'utf8'),
  fs.readFileSync(testsPath, 'utf8'),
);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('[v4 cordis host] OK real Context/Fiber/Effect boundary');
