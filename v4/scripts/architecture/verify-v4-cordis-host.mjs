#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const source = fs.readFileSync(path.join(root, 'cordis/routecodex-v4-cordis-host/src/index.mjs'), 'utf8');
const tests = fs.readFileSync(path.join(root, 'cordis/routecodex-v4-cordis-host/tests/host.test.mjs'), 'utf8');
const red = process.argv.includes('--red-self-test');
const required = [
  'from \'cordis\'',
  'new Context()',
  'FiberState.ACTIVE',
  '.isolate(',
  'fiber.dispose()',
  'plugin_not_active',
];
const forbidden = ['JSON.parse', 'metadata', 'fallback', 'next_node'];
const failures = required.filter((token) => !source.includes(token));
if (forbidden.some((token) => source.includes(token))) {
  failures.push('Cordis host contains forbidden synthetic/control pattern');
}
if (!tests.includes('Context.is(host.context)') || !tests.includes('reverse order')) {
  failures.push('black-box lifecycle tests missing');
}
if (red) {
  if (source.includes('new Context()')) {
    console.log('[v4 cordis host red] OK real-Cordis mutation detected');
    process.exit(0);
  }
  console.error('[v4 cordis host red] fixture unexpectedly passed');
  process.exit(1);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('[v4 cordis host] OK real Context/Fiber/Effect boundary');
